"""LocalPlane（偽の AgentCore）が 2026-11-23 の実測（artifacts/ac1/D1・D4・D8）と同じ動きをするかの確認。通信なし。

  - 同じ clientToken を 2 回 → 同じ processPaymentId、予算は 1 回分（D1）
  - 上限 $0.20 に $0.05 を 5 回 → 5 回目が ValidationException（HTTP 400）、文言も実測と同じ形（D4/D8）
  - 予算は証明を作った時点で減る（0.15 → 0.1 → 0.05 → 0）
  - 応答の項目名が実測（D0 の responseFields）と同じ
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "py"))
from planes import LocalPlane  # noqa: E402

ACCEPT = {"scheme": "exact", "network": "base-sepolia", "maxAmountRequired": "50000",
          "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
          "maxTimeoutSeconds": 60, "extra": {"name": "USDC", "version": "2"}}


def pay(p: LocalPlane, sid: str, token: str) -> dict:
    return p.process_payment(paymentSessionId=sid, paymentInstrumentId="i", paymentManagerArn="arn", paymentType="CRYPTO_X402",
                             paymentInput={"cryptoX402": {"version": "1", "payload": ACCEPT}}, clientToken=token)


def avail(p: LocalPlane, sid: str) -> str:
    return p.get_payment_session(paymentSessionId=sid)["paymentSession"]["availableLimits"]["availableSpendAmount"]["value"]


def main() -> int:
    measured_fields = json.loads((ROOT / "artifacts/ac1/D0.json").read_text())["findings"]["responseFields"]
    p = LocalPlane()
    sid = p.create_payment_session(limits={"maxSpendAmount": {"value": "0.20", "currency": "USD"}})["paymentSession"]["paymentSessionId"]
    a = pay(p, sid, "t" * 36)
    b = pay(p, sid, "t" * 36)
    after_d1 = avail(p, sid)
    p2 = LocalPlane()
    sid2 = p2.create_payment_session(limits={"maxSpendAmount": {"value": "0.20", "currency": "USD"}})["paymentSession"]["paymentSessionId"]
    trail, err = [], None
    for i in range(5):
        try:
            pay(p2, sid2, f"tok-{i}-" + "x" * 30)
        except ClientError as e:
            err = e
        trail.append(avail(p2, sid2))
    checks = {
        "D1: 同じ token → 同じ processPaymentId": a["processPaymentId"] == b["processPaymentId"],
        "D1: 予算は 1 回分（0.2 → 0.15）": after_d1 == "0.15",
        "D4: 5 回目が ValidationException": err is not None and err.response["Error"]["Code"] == "ValidationException",
        "D4: HTTP 400": err is not None and err.response["ResponseMetadata"]["HTTPStatusCode"] == 400,
        "D4: 文言が実測と同じ形": err is not None and err.response["Error"]["Message"].startswith("Insufficient budget for session ")
        and "Transaction amount: 0.050000 USD" in err.response["Error"]["Message"],
        "D4: 予算の推移が実測と同じ（0.15, 0.1, 0.05, 0, 0）": trail == ["0.15", "0.1", "0.05", "0", "0"],
        "D0: 応答の項目名が実測と同じ": sorted(a.keys()) == measured_fields,
    }
    ok = all(checks.values())
    print(json.dumps({"check": "local-plane-matches-measured", "result": "ok" if ok else "NG", "checks": checks,
                      "trail": trail}, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

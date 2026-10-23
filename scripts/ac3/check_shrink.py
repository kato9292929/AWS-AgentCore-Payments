"""AC-3b の「承認を 1 に縮める」ステップの単体確認（通信なし・署名なし）。

偽の PaymentManager と偽のチェーンを ac3b_mainnet.shrink_allowance に渡して、次を確かめる:
  - ProcessPayment に渡す 402 は allowlist の payTo のもので、upto・署名額 1・permit2AllowanceLimit="1"
  - 専用の小さいセッション（$0.01）を開いて閉じる
  - 戻り値（＝結果表に残すもの）に支払い署名（paymentOutput / signature）が入らない
  - allowlist に無い payTo の 402 なら ProcessPayment を呼ばない
  - 縮めた後の allowance を読んで allowance_is_1 を返す

使い方: python3 scripts/ac3/check_shrink.py（npm run check:py から呼ばれる）
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "ac3"))
sys.path.insert(0, str(ROOT / "scripts" / "py"))

import ac3b_mainnet as m  # noqa: E402
from planes import scrub  # noqa: E402

S2_PAYTO = "0x2b6D4988Db4723E6908Db86Ab2b8dFBc51FC32C5"
WALLET = "0x00000000000000000000000000000000000000Aa"
FAKE_SIG = "0x" + "ab" * 65


def fake_402(pay_to: str) -> Dict[str, Any]:
    body = {
        "x402Version": 2,
        "accepts": [
            {"scheme": "exact", "network": "eip155:8453", "amount": "2500", "payTo": pay_to},
            {"scheme": "upto", "network": "eip155:8453", "amount": "2500", "payTo": pay_to,
             "extra": {"facilitatorAddress": "0x68A96F41ff1e9F2E7b591A931A4AD224e7C07863"}},
        ],
    }
    return {"statusCode": 402, "headers": {"payment-required": base64.b64encode(json.dumps(body).encode()).decode()}, "body": {}}


class FakeMgr:
    def __init__(self) -> None:
        self.sessions: List[Dict[str, Any]] = []
        self.deleted: List[str] = []
        self.process_calls: List[Dict[str, Any]] = []

    def create_payment_session(self, **kw: Any) -> Dict[str, Any]:
        self.sessions.append(kw)
        return {"paymentSessionId": f"s{len(self.sessions)}"}

    def get_payment_session(self, **_: Any) -> Dict[str, Any]:
        return {"availableLimits": {"availableSpendAmount": {"value": "0.01", "currency": "USD"}}}

    def delete_payment_session(self, payment_session_id: str, **_: Any) -> None:
        self.deleted.append(payment_session_id)

    def process_payment(self, **kw: Any) -> Dict[str, Any]:
        self.process_calls.append(kw)
        return {"processPaymentId": "pp-shrink", "status": "PROOF_GENERATED",
                "paymentOutput": {"cryptoX402": {"version": "2", "payload": {"signature": FAKE_SIG}}}}


class FakeChain:
    def __init__(self) -> None:
        self.value = "10000"

    def block_number(self) -> int:
        return 100

    def allowance(self, usdc: str, owner: str) -> str:
        return self.value

    def wait_for_approval(self, usdc: str, owner: str, from_block: int, value: str, timeout_s: int = 90) -> Dict[str, Any]:
        self.value = value  # 承認 tx が確定した
        return {"txHash": "0x" + "cd" * 32, "value": value, "gasUsed": "50000", "gasCostEth": "0.0000005"}


def run(pay_to: str) -> Dict[str, Any]:
    m.get_402 = lambda seller: fake_402(pay_to)  # type: ignore[assignment]
    mgr, chain = FakeMgr(), FakeChain()
    out = m.shrink_allowance("2s", mgr, "user", "inst", chain, WALLET)  # type: ignore[arg-type]
    return {"out": out, "mgr": mgr}


def main() -> int:
    ok = run(S2_PAYTO)
    out, mgr = ok["out"], ok["mgr"]
    call = mgr.process_calls[0] if mgr.process_calls else {}
    cx = (call.get("payment_input") or {}).get("cryptoX402") or {}
    serialized = json.dumps(scrub(out))
    bad = run("0x000000000000000000000000000000000000dEaD")
    checks = {
        "ProcessPayment を 1 回だけ呼ぶ": len(mgr.process_calls) == 1,
        "402 は upto の accept": cx.get("payload", {}).get("scheme") == "upto",
        "署名する金額は 1": cx.get("payload", {}).get("amount") == "1",
        "permit2AllowanceLimit は \"1\"": cx.get("permit2AllowanceLimit") == "1",
        "payTo は allowlist の 2s": cx.get("payload", {}).get("payTo") == S2_PAYTO,
        "専用セッション（$0.01）を開いて閉じる": mgr.sessions and mgr.sessions[0]["limits"]["maxSpendAmount"]["value"] == "0.01"
        and mgr.deleted == ["s1"],
        "結果に paymentOutput を残さない": "paymentOutput" not in out and "paymentOutput" not in serialized,
        "結果に署名値を残さない": FAKE_SIG not in serialized and "signature" not in serialized,
        "processPaymentId と status は残す": out.get("processPaymentId") == "pp-shrink" and out.get("status") == "PROOF_GENERATED",
        "承認 tx と gas を残す": bool(out.get("approve_tx")) and out.get("approve_gas_eth") == "0.0000005",
        "縮めた後の allowance が 1": out.get("allowance_after") == "1" and out.get("allowance_is_1") is True,
        "allowlist 外の payTo なら ProcessPayment を呼ばない": bad["out"].get("executed") is False and not bad["mgr"].process_calls,
    }
    result = "ok" if all(checks.values()) else "NG"
    print(json.dumps({"check": "shrink-allowance (python)", "result": result, "checks": checks}, ensure_ascii=False, indent=2))
    return 0 if result == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())

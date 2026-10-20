"""AC-3b: BlockRun（Base mainnet、従量課金の推論）で upto の扱いを確かめる。**本人が §1-5 で可とした場合のみ**。

手順:
  1. 支払わずに 402 だけを取る（常に実行。署名しない）。upto を返すかを記録する。
  2. --allow-mainnet が無ければここで終わる。
  3. upto を返さなければ exact で 1 回払って終える。
     upto を返せば、初回だけ permit2AllowanceLimit を渡して、セッション上限に当たるまで（最大 --max-calls 回）払う。

ガード（ここで足しているもの。SDK には無い）:
  - --allow-mainnet が無い限り mainnet に署名しない
  - 支払い先は config/payto-allowlist.mainnet.json の BlockRun payTo のみ（402 を削ってから渡す）
  - セッション上限 $0.20（CreatePaymentSession の maxSpendAmount）
  - 総額 $1.00 を超えない（artifacts/ac3/mainnet-ledger.json に累計を残し、超えるなら署名しない）
  - 1 回あたり $0.05 を超える 402 には署名しない

使い方:
  python scripts/ac3/blockrun_mainnet.py                 # 402 を見るだけ
  AWS_REGION=us-east-1 AGENTCORE_PAYMENT_MANAGER_ARN=... AGENTCORE_PAYMENT_INSTRUMENT_ID=... PAYMENT_USER_EMAIL=... \\
    python scripts/ac3/blockrun_mainnet.py --allow-mainnet
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import uuid
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List

import httpx

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "examples"))
sys.path.insert(0, str(ROOT / "scripts" / "py"))
from payto_guard import PayToAllowlist, PayToRejected  # noqa: E402
from planes import scrub  # noqa: E402

URL = "https://blockrun.ai/api/v1/chat/completions"
BODY = {"model": "openai/gpt-4o-mini", "messages": [{"role": "user", "content": "Say OK."}], "max_tokens": 8}
LEDGER = ROOT / "artifacts" / "ac3" / "mainnet-ledger.json"
OUT = ROOT / "artifacts" / "ac3" / "blockrun-mainnet.json"
TOTAL_CAP = Decimal("1.00")
PER_CALL_CAP = Decimal("0.05")
SESSION_CAP = "0.20"


def get_402() -> Dict[str, Any]:
    r = httpx.post(URL, json=BODY, timeout=30)
    try:
        body: Any = r.json()
    except Exception:  # noqa: BLE001
        body = {"text": r.text[:300]}
    return {"statusCode": r.status_code, "headers": dict(r.headers), "body": body}


def accepts_of(req: Dict[str, Any]) -> List[Dict[str, Any]]:
    for k, v in req["headers"].items():
        if k.lower() == "payment-required":
            return json.loads(base64.b64decode(v)).get("accepts", [])
    b = req.get("body")
    return b.get("accepts", []) if isinstance(b, dict) else []


def keep_scheme(req: Dict[str, Any], scheme: str) -> Dict[str, Any]:
    """402 から指定 scheme の accept だけを残す（SDK に選ばせない）。"""
    out = json.loads(json.dumps(req))
    for k, v in list(out["headers"].items()):
        if k.lower() == "payment-required":
            p = json.loads(base64.b64decode(v))
            p["accepts"] = [a for a in p["accepts"] if a.get("scheme") == scheme]
            out["headers"][k] = base64.b64encode(json.dumps(p).encode()).decode()
        if k.lower() == "www-authenticate":
            del out["headers"][k]  # BlockRun の "X402 requirements=" は MPP ではないが、紛れないよう外す
    if isinstance(out.get("body"), dict) and "accepts" in out["body"]:
        out["body"]["accepts"] = [a for a in out["body"]["accepts"] if a.get("scheme") == scheme]
    return out


def ledger_total() -> Decimal:
    if not LEDGER.exists():
        return Decimal("0")
    return Decimal(json.loads(LEDGER.read_text())["total_usd"])


def ledger_add(usd: Decimal, ref: str) -> None:
    d = json.loads(LEDGER.read_text()) if LEDGER.exists() else {"total_usd": "0", "entries": []}
    d["entries"].append({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "usd": str(usd), "ref": ref})
    d["total_usd"] = str(Decimal(d["total_usd"]) + usd)
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    LEDGER.write_text(json.dumps(d, indent=2) + "\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--allow-mainnet", action="store_true")
    ap.add_argument("--max-calls", type=int, default=5)
    args = ap.parse_args()

    record: Dict[str, Any] = {"seller": URL, "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    req = get_402()
    acc = accepts_of(req)
    record["probe"] = {
        "http_status": req["statusCode"],
        "accepts": [{k: a.get(k) for k in ("scheme", "network", "amount", "maxAmountRequired", "payTo", "asset")} for a in acc],
        "offers_upto": any(a.get("scheme") == "upto" for a in acc),
    }
    if not args.allow_mainnet:
        record["paid"] = False
        record["reason"] = "--allow-mainnet が無い（402 を見ただけ。署名していない）"
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(scrub(record), ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(record["probe"], ensure_ascii=False, indent=2))
        return 0

    from bedrock_agentcore.payments.manager import PaymentManager
    from planes import calls_to_json, spy

    user = os.environ["PAYMENT_USER_EMAIL"]
    inst = os.environ["AGENTCORE_PAYMENT_INSTRUMENT_ID"]
    mgr = PaymentManager(payment_manager_arn=os.environ["AGENTCORE_PAYMENT_MANAGER_ARN"],
                         region_name=os.environ.get("AWS_REGION", "us-east-1"), agent_name="ac3b-blockrun")
    calls = spy(mgr)
    allow = PayToAllowlist.load(ROOT / "config" / "payto-allowlist.mainnet.json")
    sess = mgr.create_payment_session(expiry_time_in_minutes=15, user_id=user,
                                      limits={"maxSpendAmount": {"value": SESSION_CAP, "currency": "USD"}})
    sid = sess.get("paymentSessionId") or sess.get("paymentSession", {}).get("paymentSessionId")
    scheme = "upto" if record["probe"]["offers_upto"] else "exact"
    n = args.max_calls if scheme == "upto" else 1
    runs: List[Dict[str, Any]] = []
    try:
        for i in range(1, n + 1):
            r: Dict[str, Any] = {"i": i, "scheme": scheme}
            req = keep_scheme(get_402(), scheme)
            try:
                req, report = allow.filter_402(req)
            except PayToRejected as e:
                r["error"] = f"allowlist: {e}"
                runs.append(r)
                break
            a = accepts_of(req)[0]
            amount = Decimal(int(a.get("amount") or a.get("maxAmountRequired"))) / Decimal(10**6)
            if amount > PER_CALL_CAP:
                r["error"] = f"1 回 {amount} USD > {PER_CALL_CAP}（署名しない）"
                runs.append(r)
                break
            if ledger_total() + amount > TOTAL_CAP:
                r["error"] = f"総額 {ledger_total()} + {amount} > {TOTAL_CAP}（署名しない）"
                runs.append(r)
                break
            s0 = mgr.get_payment_session(payment_session_id=sid, user_id=user)
            t0 = time.time()
            try:
                header = mgr.generate_payment_header(
                    user_id=user, payment_instrument_id=inst, payment_session_id=sid, payment_required_request=req,
                    network_preferences=["eip155:8453"], client_token=str(uuid.uuid4()),
                    permit2_allowance_limit=os.environ.get("AGENTCORE_PERMIT2_ALLOWANCE_LIMIT", "1000000") if (scheme == "upto" and i == 1) else None,
                )
            except Exception as e:  # noqa: BLE001
                r["error"] = f"{type(e).__name__}: {e}"
                runs.append(r)
                break
            resp = httpx.post(URL, json=BODY, headers=header, timeout=60)
            r.update({
                "http_status": resp.status_code,
                "latency_ms": round((time.time() - t0) * 1000),
                "cap_usd": str(amount),
                "response_headers": {k: v for k, v in resp.headers.items() if "payment" in k.lower() or k.lower().startswith("x-")},
                "budget_before": (s0.get("availableLimits") or {}).get("availableSpendAmount"),
                "budget_after": (mgr.get_payment_session(payment_session_id=sid, user_id=user).get("availableLimits") or {}).get("availableSpendAmount"),
            })
            if 200 <= resp.status_code < 300:
                ledger_add(amount, r["response_headers"].get("x-payment-response", "")[:64])
            runs.append(r)
            if resp.status_code >= 300:
                break
    finally:
        try:
            mgr.delete_payment_session(payment_session_id=sid, user_id=user)
        except Exception:  # noqa: BLE001
            pass
    record.update({"paid": True, "runs": runs, "process_payment": calls_to_json(calls), "ledger_total_usd": str(ledger_total())})
    OUT.write_text(json.dumps(scrub(record), ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(record, ensure_ascii=False, indent=2)[:2000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

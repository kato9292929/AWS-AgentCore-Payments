"""AC-3b: mainnet（Base）で upto の扱いを確かめる。**支払いは本人が §1-5 で可とした場合のみ**。

売り手は 2 つ。
  2s        POST https://2s.io/api/ai/chat                 … upto の実測対象（上限額を承認し、実使用分だけ settle される）
  blockrun  POST https://blockrun.ai/api/v1/chat/completions … exact の参照値（BlockRun は upto を返さない）

手順:
  1. 支払わずに 402 だけを取る（常に実行。署名しない）。
     upto なら 上限額（v2 の amount。v1 の maxAmountRequired に当たる）・extra.facilitatorAddress・payTo・network を記録する。
  2. --allow-mainnet が無ければここで終わる。
  3. 2s: 初回だけ permit2AllowanceLimit を渡して upto で払う（最大 --max-calls 回）。
         各回の前後で GetPaymentSession の残予算を取り、1 回あたりの減り方（上限額か実額か）を記録する。
         初回の前後でウォレットの ETH 残高を取り、Permit2 approve の gas を測る（AGENTCORE_WALLET_ADDRESS）。
     blockrun: exact で 1 回払う（参照値）。

ガード（ここで足しているもの。SDK には無い）:
  - --allow-mainnet が無い限り mainnet に署名しない
  - 支払い先は config/payto-allowlist.mainnet.json のうち、その売り手の payTo だけ（402 を削ってから渡す）
  - セッション上限 $0.20（CreatePaymentSession の maxSpendAmount。売り手ごとに 1 セッション）
  - 総額 $1.00 を超えない（artifacts/ac3/mainnet-ledger.json に累計を残し、上限額で見積もって超えるなら署名しない）
  - 1 回あたり（upto は上限額で）$0.05 を超える 402 には署名しない

使い方:
  python scripts/ac3/ac3b_mainnet.py                          # 両方の 402 を見るだけ
  AWS_REGION=us-east-1 AGENTCORE_PAYMENT_MANAGER_ARN=... AGENTCORE_PAYMENT_INSTRUMENT_ID=... PAYMENT_USER_EMAIL=... \\
  AGENTCORE_WALLET_ADDRESS=0x... python scripts/ac3/ac3b_mainnet.py --allow-mainnet [--seller=2s|blockrun|2s,blockrun]

出力: artifacts/ac3/ac3b-mainnet.json
承認: 2s の初回に Permit2 へ 0.01 USDC を approve し、試験の最後に 1（0.000001 USDC）まで縮める（shrink_allowance）。
      縮めた後の allowance は RPC で読んで記録する。完全に 0 にするには、ウォレット側で USDC.approve(Permit2, 0) を
      送る必要がある（AgentCore の API からはできない。permit2AllowanceLimit は正の整数のみ）。
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
from typing import Any, Dict, List, Optional

import httpx

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "examples"))
sys.path.insert(0, str(ROOT / "scripts" / "py"))
from payto_guard import PayToAllowlist, PayToRejected  # noqa: E402
from chain import Chain  # noqa: E402
from planes import scrub  # noqa: E402

SELLERS: Dict[str, Dict[str, Any]] = {
    "2s": {
        "url": "https://2s.io/api/ai/chat",
        "body": {"model": "openai/gpt-4o-mini", "messages": [{"role": "user", "content": "Say OK."}], "max_tokens": 8},
        "role": "upto の実測対象",
        "scheme": "upto",
        "max_calls": 3,
        # 1 回の上限が $0.0025 なので 0.01 USDC で足りる（試験の最後に 1 まで縮める）
        "permit2_limit": "10000",
    },
    "blockrun": {
        "url": "https://blockrun.ai/api/v1/chat/completions",
        "body": {"model": "openai/gpt-4o-mini", "messages": [{"role": "user", "content": "Say OK."}], "max_tokens": 8},
        "role": "exact の参照値（upto を返さない）",
        "scheme": "exact",
        "max_calls": 1,
    },
}
ALLOWLIST = ROOT / "config" / "payto-allowlist.mainnet.json"
LEDGER = ROOT / "artifacts" / "ac3" / "mainnet-ledger.json"
OUT = ROOT / "artifacts" / "ac3" / "ac3b-mainnet.json"
TOTAL_CAP = Decimal("1.00")
PER_CALL_CAP = Decimal("0.05")
SESSION_CAP = "0.20"
BASE_RPC = os.environ.get("BASE_MAINNET_RPC", "https://mainnet.base.org")
USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
FEE_PER_WALLET_OP_USD = "0.005"


def get_402(seller: Dict[str, Any]) -> Dict[str, Any]:
    r = httpx.post(seller["url"], json=seller["body"], timeout=30)
    try:
        body: Any = r.json()
    except Exception:  # noqa: BLE001
        body = {"text": r.text[:300]}
    return {"statusCode": r.status_code, "headers": dict(r.headers), "body": body}


def required_of(req: Dict[str, Any]) -> Dict[str, Any]:
    for k, v in req["headers"].items():
        if k.lower() == "payment-required":
            return json.loads(base64.b64decode(v))
    b = req.get("body")
    return b if isinstance(b, dict) else {}


def summarize_accept(a: Dict[str, Any]) -> Dict[str, Any]:
    extra = a.get("extra") or {}
    return {
        "scheme": a.get("scheme"),
        "network": a.get("network"),
        # v2 は amount、v1 は maxAmountRequired。upto ではどちらも「上限額」
        "maxAmountRequired": a.get("maxAmountRequired") or a.get("amount"),
        "field": "maxAmountRequired" if a.get("maxAmountRequired") else "amount",
        "asset": a.get("asset"),
        "payTo": a.get("payTo"),
        "maxTimeoutSeconds": a.get("maxTimeoutSeconds"),
        "facilitatorAddress": extra.get("facilitatorAddress"),
        "extra_name": extra.get("name"),
    }


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


def allowlist_for(seller_key: str) -> PayToAllowlist:
    entries = json.loads(ALLOWLIST.read_text(encoding="utf-8"))["entries"]
    return PayToAllowlist([e for e in entries if e.get("seller") == seller_key])


def ledger_total() -> Decimal:
    if not LEDGER.exists():
        return Decimal("0")
    return Decimal(json.loads(LEDGER.read_text())["total_usd"])


def ledger_add(usd: Decimal, ref: str, seller: str) -> None:
    d = json.loads(LEDGER.read_text()) if LEDGER.exists() else {"total_usd": "0", "entries": []}
    d["entries"].append({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "seller": seller, "usd": str(usd), "ref": ref})
    d["total_usd"] = str(Decimal(d["total_usd"]) + usd)
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    LEDGER.write_text(json.dumps(d, indent=2) + "\n")


def eth_balance(addr: Optional[str]) -> Optional[str]:
    if not addr:
        return None
    r = httpx.post(BASE_RPC, json={"jsonrpc": "2.0", "id": 1, "method": "eth_getBalance", "params": [addr, "latest"]}, timeout=15)
    return str(Decimal(int(r.json()["result"], 16)) / Decimal(10**18))


def settlement_of(resp: httpx.Response) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for name in ("payment-response", "x-payment-response"):
        v = resp.headers.get(name)
        if v:
            try:
                out["settlement"] = json.loads(base64.b64decode(v))
            except Exception:  # noqa: BLE001
                out["settlement_raw_len"] = len(v)
    if resp.headers.get("x-payment-tx"):  # 2s は settle の tx をこのヘッダで返す
        out["x_payment_tx"] = resp.headers["x-payment-tx"]
    return out


def budget(mgr: Any, sid: str, user: str) -> Optional[str]:
    a = (mgr.get_payment_session(payment_session_id=sid, user_id=user).get("availableLimits") or {}).get("availableSpendAmount")
    return f"{a.get('value')} {a.get('currency')}" if a else None


def resolve_wallet(mgr: Any, user: str, inst: str) -> Optional[str]:
    if os.environ.get("AGENTCORE_WALLET_ADDRESS"):
        return os.environ["AGENTCORE_WALLET_ADDRESS"]
    try:
        d = mgr.get_payment_instrument(payment_instrument_id=inst, user_id=user)
        return ((d.get("paymentInstrumentDetails") or {}).get("embeddedCryptoWallet") or {}).get("walletAddress")
    except Exception:  # noqa: BLE001
        return None


def shrink_allowance(key: str, mgr: Any, user: str, inst: str, chain: Chain, wallet: Optional[str]) -> Dict[str, Any]:
    """試験の最後に Permit2 の承認を 1（0.000001 USDC）に縮める。--allow-mainnet のときだけ呼ばれる。

    AgentCore には承認だけを出す API が無く、permit2AllowanceLimit は正の整数しか受けない（0 にはできない）。
    同じ売り手から取り直した 402 の upto accept を金額 1 に書き換え、permit2AllowanceLimit="1" で ProcessPayment を 1 回呼ぶ。
    サービスは署名の前に approve(Permit2, 1) を出す。生成された支払い署名（paymentOutput）は使わず、変数にも残さない。
    記録するのは processPaymentId・status・承認 tx・gas・予算の変化・縮めた後の allowance だけ。
    """
    seller = SELLERS[key]
    req = keep_scheme(get_402(seller), "upto")
    try:
        req, _ = allowlist_for(key).filter_402(req)
    except PayToRejected as e:
        return {"executed": False, "reason": f"allowlist（{key} の payTo のみ）: {e}"}
    accepts = required_of(req).get("accepts", [])
    if not accepts:
        return {"executed": False, "reason": "取り直した 402 に upto が無い"}
    accept = {**accepts[0], "amount": "1"}  # 署名する金額も最小にする（この署名は使わない）
    sess = mgr.create_payment_session(expiry_time_in_minutes=15, user_id=user,
                                      limits={"maxSpendAmount": {"value": "0.01", "currency": "USD"}})
    sid = sess.get("paymentSessionId") or sess.get("paymentSession", {}).get("paymentSessionId")
    from_block = chain.block_number()
    out: Dict[str, Any] = {
        "executed": True,
        "permit2AllowanceLimit": "1",
        "signed_amount_atomic": "1",
        "session": "専用（上限 $0.01）",
        "facilitatorAddress": (accept.get("extra") or {}).get("facilitatorAddress"),
        "allowance_before": chain.allowance(USDC_BASE, wallet) if wallet else None,
        "budget_before": budget(mgr, sid, user),
    }
    try:
        res = mgr.process_payment(
            payment_session_id=sid, payment_instrument_id=inst, payment_type="CRYPTO_X402", user_id=user,
            payment_input={"cryptoX402": {"version": "2", "payload": accept, "permit2AllowanceLimit": "1"}},
            client_token=str(uuid.uuid4()),
        )
        # paymentOutput（支払い署名）はここで捨てる
        out["processPaymentId"] = res.get("processPaymentId")
        out["status"] = res.get("status")
        del res
    except Exception as e:  # noqa: BLE001
        out["error"] = f"{type(e).__name__}: {e}"
    try:
        out["budget_after"] = budget(mgr, sid, user)
    finally:
        try:
            mgr.delete_payment_session(payment_session_id=sid, user_id=user)
        except Exception:  # noqa: BLE001
            pass
    if wallet and "error" not in out:
        out["approve_tx"] = chain.wait_for_approval(USDC_BASE, wallet, from_block, "1")
        out["approve_gas_eth"] = (out["approve_tx"] or {}).get("gasCostEth")
    out["allowance_after"] = chain.allowance(USDC_BASE, wallet) if wallet else None
    out["allowance_is_1"] = out["allowance_after"] == "1"
    return out


def pay_seller(key: str, mgr: Any, user: str, inst: str, max_calls: Optional[int]) -> Dict[str, Any]:
    from planes import calls_to_json, spy

    seller = SELLERS[key]
    scheme = seller["scheme"]
    allow = allowlist_for(key)
    all_calls = spy(mgr)
    n0 = len(all_calls)  # 売り手ごとの区切り（spy は manager ごとに 1 つのリストを共有する）
    sess = mgr.create_payment_session(expiry_time_in_minutes=15, user_id=user,
                                      limits={"maxSpendAmount": {"value": SESSION_CAP, "currency": "USD"}})
    sid = sess.get("paymentSessionId") or sess.get("paymentSession", {}).get("paymentSessionId")
    wallet = resolve_wallet(mgr, user, inst)
    chain = Chain(BASE_RPC)
    start_block = chain.block_number()
    allowance_before = chain.allowance(USDC_BASE, wallet) if wallet else None
    runs: List[Dict[str, Any]] = []
    shrink: Optional[Dict[str, Any]] = None
    try:
        for i in range(1, (max_calls or seller["max_calls"]) + 1):
            r: Dict[str, Any] = {"i": i, "scheme": scheme}
            req = get_402(seller)
            if req["statusCode"] != 402:
                r["error"] = f"402 が返らなかった（{req['statusCode']}）"
                runs.append(r)
                break
            req = keep_scheme(req, scheme)
            try:
                req, report = allow.filter_402(req)
            except PayToRejected as e:
                r["error"] = f"allowlist（{key} の payTo のみ）: {e}"
                runs.append(r)
                break
            accepts = required_of(req).get("accepts", [])
            if not accepts:
                r["error"] = f"{scheme} の accept が無い"
                runs.append(r)
                break
            acc = summarize_accept(accepts[0])
            r["offer"] = acc
            cap = Decimal(int(acc["maxAmountRequired"])) / Decimal(10**6)
            if cap > PER_CALL_CAP:
                r["error"] = f"1 回（上限額）{cap} USD > {PER_CALL_CAP}（署名しない）"
                runs.append(r)
                break
            if ledger_total() + cap > TOTAL_CAP:
                r["error"] = f"総額 {ledger_total()} + {cap} > {TOTAL_CAP}（署名しない）"
                runs.append(r)
                break
            permit2 = seller.get("permit2_limit") if (scheme == "upto" and i == 1) else None
            r["permit2AllowanceLimit"] = permit2
            r["budget_before"] = budget(mgr, sid, user)
            if permit2:
                r["eth_before"] = eth_balance(wallet)
            t0 = time.time()
            try:
                header = mgr.generate_payment_header(
                    user_id=user, payment_instrument_id=inst, payment_session_id=sid, payment_required_request=req,
                    network_preferences=["eip155:8453"], client_token=str(uuid.uuid4()),
                    permit2_allowance_limit=permit2,
                )
            except Exception as e:  # noqa: BLE001
                r["error"] = f"{type(e).__name__}: {e}"
                r["budget_after"] = budget(mgr, sid, user)
                runs.append(r)
                break
            r["budget_after_proof"] = budget(mgr, sid, user)
            if permit2:
                r["eth_after_approve"] = eth_balance(wallet)
            resp = httpx.post(seller["url"], json=seller["body"], headers=header, timeout=60)
            r.update({
                "http_status": resp.status_code,
                "latency_ms": round((time.time() - t0) * 1000),
                "cap_usd": str(cap),
                **settlement_of(resp),
            })
            time.sleep(5)
            r["budget_after_settle_5s"] = budget(mgr, sid, user)
            if 200 <= resp.status_code < 300:
                settled = (r.get("settlement") or {}).get("amount")
                # 実額が分からなければ上限額で台帳に積む（少なく見積もらない）
                usd = Decimal(int(settled)) / Decimal(10**6) if settled and str(settled).isdigit() else cap
                ledger_add(usd, str(r.get("x_payment_tx") or (r.get("settlement") or {}).get("transaction") or "")[:66], key)
            runs.append(r)
            if resp.status_code >= 300:
                break
    finally:
        try:
            mgr.delete_payment_session(payment_session_id=sid, user_id=user)
        except Exception:  # noqa: BLE001
            pass
        allowance_after_test = chain.allowance(USDC_BASE, wallet) if wallet else None
        # 承認を出した可能性があれば（upto で ProcessPayment を 1 回でも呼んだら）必ず縮める
        if scheme == "upto" and len(all_calls) > n0:
            try:
                shrink = shrink_allowance(key, mgr, user, inst, chain, wallet)
            except Exception as e:  # noqa: BLE001
                shrink = {"executed": False, "error": f"{type(e).__name__}: {e}"}
    calls = all_calls[n0:]
    test_calls = len(calls) - (1 if shrink and shrink.get("executed") else 0)
    approvals = chain.approvals(USDC_BASE, wallet, start_block) if wallet else []
    first_approval = next((a for a in approvals if a["value"] == seller.get("permit2_limit")), None)
    first = runs[0] if runs else {}
    gas_by_balance = None
    if first.get("eth_before") and first.get("eth_after_approve"):
        gas_by_balance = str(Decimal(first["eth_before"]) - Decimal(first["eth_after_approve"]))
    return {
        "paid": True,
        "runs": runs,
        "permit2AllowanceLimit_first_call_only": seller.get("permit2_limit"),
        "approve_tx": first_approval,
        "approve_gas_eth": (first_approval or {}).get("gasCostEth") or gas_by_balance,
        "allowance_permit2": {
            "unit": "USDC の最小単位（6 decimals）",
            "before_test": allowance_before,
            "after_test": allowance_after_test,
            "after_shrink": (shrink or {}).get("allowance_after"),
        } if scheme == "upto" else None,
        "shrink": shrink,
        "wallet_operations": {
            "test_process_payment": test_calls,
            "shrink_process_payment": 1 if shrink and shrink.get("executed") else 0,
            "fee_per_operation_usd": FEE_PER_WALLET_OP_USD,
        },
        "process_payment": calls_to_json(calls),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--allow-mainnet", action="store_true")
    ap.add_argument("--seller", default="2s,blockrun")
    ap.add_argument("--max-calls", type=int, default=None)
    args = ap.parse_args()
    keys = [k for k in args.seller.split(",") if k]
    unknown = [k for k in keys if k not in SELLERS]
    if unknown:
        print(f"未知の売り手: {unknown}（{list(SELLERS)}）", file=sys.stderr)
        return 1

    record: Dict[str, Any] = {
        "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "guards": {"allow_mainnet": args.allow_mainnet, "session_cap_usd": SESSION_CAP,
                   "total_cap_usd": str(TOTAL_CAP), "per_call_cap_usd": str(PER_CALL_CAP)},
        "sellers": {},
    }
    for key in keys:
        seller = SELLERS[key]
        req = get_402(seller)
        req_body = required_of(req)
        record["sellers"][key] = {
            "url": seller["url"],
            "role": seller["role"],
            "probe": {
                "http_status": req["statusCode"],
                "x402Version": req_body.get("x402Version"),
                "accepts": [summarize_accept(a) for a in req_body.get("accepts", [])],
                "offers_upto": any(a.get("scheme") == "upto" for a in req_body.get("accepts", [])),
            },
            "paid": False,
        }

    if args.allow_mainnet:
        from bedrock_agentcore.payments.manager import PaymentManager

        user = os.environ["PAYMENT_USER_EMAIL"]
        inst = os.environ["AGENTCORE_PAYMENT_INSTRUMENT_ID"]
        mgr = PaymentManager(payment_manager_arn=os.environ["AGENTCORE_PAYMENT_MANAGER_ARN"],
                             region_name=os.environ.get("AWS_REGION", "us-east-1"), agent_name="ac3b-mainnet")
        for key in keys:
            record["sellers"][key].update(pay_seller(key, mgr, user, inst, args.max_calls))
        record["ledger_total_usd"] = str(ledger_total())
    else:
        for key in keys:
            record["sellers"][key]["reason"] = "--allow-mainnet が無い（402 を見ただけ。署名していない）"

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(scrub(record), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v["probe"] for k, v in record["sellers"].items()}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

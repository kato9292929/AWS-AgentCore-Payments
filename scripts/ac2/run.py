"""AC-2: Coinbase 経路の AgentCore で、testnet の実在する売り手に 402 → 署名 → 再送 → 200 を通す。

測るもの（artifacts/ac2/ と docs/AC2-results.md）:
  - 402 受信から 200 までの時間（10 回、中央値）
  - オンチェーンの settle の tx ハッシュと金額（売り手の PAYMENT-RESPONSE と、Base Sepolia の RPC で receipt を引いて照合）
  - processPaymentId / status / 残予算
  - Strands プラグイン経由の 1 周（GuardedPaymentsPlugin。モデルは台本＝LLM の可否に依存しない）
  - MPP: 売り手が MPP を返すときだけ同じことをする

経路は PaymentManager.generate_payment_header を直接呼ぶ形（プラグインが内部で呼ぶものと同じ）。
時間はモデルの思考時間を含めないため、こちらで測る。

支払い先 allowlist（config/payto-allowlist.json）に無い (payTo, network) は 402 から削ってから渡す。
1 件も残らなければ署名しない。

使い方:
  # live（要: provision の出力と AWS 資格情報）
  AWS_REGION=us-east-1 AGENTCORE_PAYMENT_MANAGER_ARN=... AGENTCORE_PAYMENT_INSTRUMENT_ID=... \\
  AGENTCORE_PAYMENT_SESSION_ID=... PAYMENT_USER_EMAIL=... \\
    python scripts/ac2/run.py --url=https://x402.org/protected --n=10

  # 結線の自己確認（AgentCore を呼ばない。模擬売り手に LocalPlane で払う。artifacts には書かない）
  python scripts/ac2/run.py --plane=local --url=http://127.0.0.1:8402/x402/v2/weather --n=3 --out=/tmp/ac2-selftest
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import statistics
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "examples"))
sys.path.insert(0, str(ROOT / "scripts" / "py"))

from payto_guard import PayToAllowlist, PayToRejected  # noqa: E402
from planes import calls_to_json, install_local_plane, scrub, spy  # noqa: E402

BASE_SEPOLIA_RPC = os.environ.get("BASE_SEPOLIA_RPC", "https://sepolia.base.org")
USDC_BASE_SEPOLIA = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
TESTNET = {"base-sepolia", "eip155:84532"}
TESTNET_PREFERRED = ["base-sepolia", "eip155:84532"]


def jst(ts: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S+09:00", time.gmtime(ts + 9 * 3600))


def to_req(r: httpx.Response) -> Dict[str, Any]:
    try:
        body: Any = r.json()
    except Exception:  # noqa: BLE001
        body = {"text": r.text[:500]}
    return {"statusCode": r.status_code, "headers": dict(r.headers), "body": body}


def decode_settlement(headers: httpx.Headers) -> Optional[Dict[str, Any]]:
    for name in ("payment-response", "x-payment-response"):
        v = headers.get(name)
        if v:
            try:
                return json.loads(base64.b64decode(v))
            except Exception:  # noqa: BLE001
                return {"raw": v[:200]}
    v = headers.get("payment-receipt")  # MPP
    if v:
        try:
            return json.loads(base64.urlsafe_b64decode(v + "=" * (-len(v) % 4)))
        except Exception:  # noqa: BLE001
            return {"raw": v[:200]}
    return None


def onchain(tx: str) -> Dict[str, Any]:
    """Base Sepolia の receipt を引いて、USDC Transfer の金額と gas を取り出す。"""
    try:
        r = httpx.post(
            BASE_SEPOLIA_RPC,
            json={"jsonrpc": "2.0", "id": 1, "method": "eth_getTransactionReceipt", "params": [tx]},
            timeout=15,
        ).json()
    except Exception as e:  # noqa: BLE001
        return {"verified": False, "error": f"{type(e).__name__}: {e}"}
    rc = r.get("result")
    if not rc:
        return {"verified": False, "error": r.get("error") or "receipt not found"}
    transfers = [
        {
            "from": "0x" + lg["topics"][1][-40:],
            "to": "0x" + lg["topics"][2][-40:],
            "amount_atomic": str(int(lg["data"], 16)),
        }
        for lg in rc.get("logs", [])
        if lg.get("address", "").lower() == USDC_BASE_SEPOLIA and lg["topics"][0] == TRANSFER_TOPIC
    ]
    return {
        "verified": True,
        "status": int(rc["status"], 16),
        "blockNumber": int(rc["blockNumber"], 16),
        "gasUsed": int(rc["gasUsed"], 16),
        "effectiveGasPrice": int(rc.get("effectiveGasPrice", "0x0"), 16),
        "usdc_transfers": transfers,
        "note": "gas は facilitator（売り手側）が払った tx のもの。買い手のウォレットからは出ていない",
    }


class Runner:
    def __init__(self, plane: str):
        from bedrock_agentcore.payments.manager import PaymentManager

        self.plane = plane
        self.user_id = os.environ.get("PAYMENT_USER_EMAIL", "local-user")
        self.instrument_id = os.environ.get("AGENTCORE_PAYMENT_INSTRUMENT_ID", "local-instrument")
        self.session_id = os.environ.get("AGENTCORE_PAYMENT_SESSION_ID", "local-session")
        self.manager = PaymentManager(
            payment_manager_arn=os.environ.get(
                "AGENTCORE_PAYMENT_MANAGER_ARN", "arn:aws:bedrock-agentcore:us-east-1:000000000000:payment-manager/local"
            ),
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
            agent_name="ac2-runner",
        )
        self.calls = spy(self.manager) if plane == "live" else install_local_plane(self.manager).calls
        self.allowlist = PayToAllowlist.load()

    def budget(self) -> Optional[str]:
        if self.plane != "live":
            return None
        try:
            s = self.manager.get_payment_session(payment_session_id=self.session_id, user_id=self.user_id)
            a = (s.get("availableLimits") or {}).get("availableSpendAmount") or {}
            return f"{a.get('value')} {a.get('currency')}" if a else None
        except Exception as e:  # noqa: BLE001
            return f"error:{type(e).__name__}"

    def once(self, url: str, i: int, protocol: str) -> Dict[str, Any]:
        rec: Dict[str, Any] = {"i": i, "url": url, "protocol": protocol, "plane": self.plane}
        t_start = time.time()
        r402 = httpx.get(url, timeout=30, headers={"Accept-Payment": "evm/charge"} if protocol == "MPP" else {})
        t_402 = time.time()
        rec["timestamp_jst"] = jst(t_start)
        rec["first_status"] = r402.status_code
        if r402.status_code != 402:
            rec["error"] = f"402 が返らなかった（{r402.status_code}）"
            return rec
        req = to_req(r402)
        if protocol == "x402":
            # MPP チャレンジを外して x402 だけを渡す（SDK は MPP を優先するため）
            req["headers"] = {k: v for k, v in req["headers"].items() if k.lower() != "www-authenticate"}
        try:
            req, report = self.allowlist.filter_402(req)
        except PayToRejected as e:
            rec["error"] = f"payTo allowlist で拒否（署名していない）: {e}"
            return rec
        rec["payto_guard"] = report
        non_testnet = [k for k in report["kept"] if str(k.get("network", "")).lower() not in TESTNET]
        if non_testnet:
            rec["error"] = f"testnet 以外が残った（署名しない）: {non_testnet}"
            return rec
        before = self.budget()
        n_calls = len(self.calls)
        try:
            header = self.manager.generate_payment_header(
                user_id=self.user_id,
                payment_instrument_id=self.instrument_id,
                payment_session_id=self.session_id,
                payment_required_request=req,
                network_preferences=TESTNET_PREFERRED,
                client_token=str(uuid.uuid4()),
                buyer_pays_gas_fees=False,
            )
        except Exception as e:  # noqa: BLE001
            rec["error"] = f"generate_payment_header: {type(e).__name__}: {e}"
            rec["process_payment"] = calls_to_json(self.calls[n_calls:])
            return rec
        t_signed = time.time()
        r200 = httpx.get(url, headers=header, timeout=60)
        t_done = time.time()
        settlement = decode_settlement(r200.headers)
        rec.update(
            {
                "http_status": r200.status_code,
                "delivered": 200 <= r200.status_code < 300,
                "latency_ms": round((t_done - t_402) * 1000),
                "breakdown_ms": {
                    "bare_request": round((t_402 - t_start) * 1000),
                    "process_payment": round((t_signed - t_402) * 1000),
                    "resend": round((t_done - t_signed) * 1000),
                },
                "header_name": next(iter(header.keys())),
                "process_payment": calls_to_json(self.calls[n_calls:]),
                "settlement": settlement,
                "budget_before": before,
                "budget_after": self.budget(),
                "body_head": r200.text[:200],
            }
        )
        tx = (settlement or {}).get("transaction") or (settlement or {}).get("reference")
        if self.plane == "live" and tx:
            rec["onchain"] = onchain(tx)
        return rec


def plugin_run(url: str, plane: str) -> Dict[str, Any]:
    """examples/pay_with_strands.py の GuardedPaymentsPlugin を台本モデルで 1 周させる。"""
    from bedrock_agentcore.payments.integrations.strands import AgentCorePaymentsPluginConfig
    from pay_with_strands import TESTNET_PREFERRED as EX_PREF, GuardedPaymentsPlugin
    from scripted_model import ScriptedModel
    from strands import Agent

    cfg = AgentCorePaymentsPluginConfig(
        payment_manager_arn=os.environ.get(
            "AGENTCORE_PAYMENT_MANAGER_ARN", "arn:aws:bedrock-agentcore:us-east-1:000000000000:payment-manager/local"
        ),
        user_id=os.environ.get("PAYMENT_USER_EMAIL", "local-user"),
        payment_instrument_id=os.environ.get("AGENTCORE_PAYMENT_INSTRUMENT_ID", "local-instrument"),
        payment_session_id=os.environ.get("AGENTCORE_PAYMENT_SESSION_ID", "local-session"),
        region=os.environ.get("AWS_REGION", "us-east-1"),
        network_preferences_config=EX_PREF,
        auto_session=False,
        buyer_pays_gas_fees=False,
        agent_name="ac2-plugin",
    )
    plugin = GuardedPaymentsPlugin(config=cfg, allowlist=PayToAllowlist.load())
    model = ScriptedModel([{"tool": "http_request", "input": {"url": url}}, {"text": "done"}])
    agent = Agent(model=model, plugins=[plugin], callback_handler=None)
    calls = spy(plugin.payment_manager) if plane == "live" else install_local_plane(plugin.payment_manager).calls
    t0 = time.time()
    agent("go")
    final = model.seen_tool_results[-1] if model.seen_tool_results else ""
    import re

    m = re.search(r'"statusCode":\s*(\d+)', final)
    status = int(m.group(1)) if m else None
    return {
        "path": "strands-plugin (GuardedPaymentsPlugin + scripted model)",
        "elapsed_s": round(time.time() - t0, 1),
        "final_status": status,
        "process_payment": calls_to_json(calls),
        "guard_log": plugin.guard_log,
        "final_tool_result_head": final[:300],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="https://x402.org/protected")
    ap.add_argument("--mpp-url", default=None, help="MPP を返す testnet 売り手（無ければ省略）")
    ap.add_argument("--n", type=int, default=10)
    ap.add_argument("--plane", choices=["live", "local"], default="live")
    ap.add_argument("--out", default="artifacts/ac2")
    ap.add_argument("--no-plugin", action="store_true")
    args = ap.parse_args()

    if any(k.upper().startswith("MAINNET") for k in os.environ):
        print("env に MAINNET_* がある。実マネー禁止のため停止する", file=sys.stderr)
        return 2
    if args.plane == "live":
        missing = [k for k in ("AGENTCORE_PAYMENT_MANAGER_ARN", "AGENTCORE_PAYMENT_INSTRUMENT_ID",
                               "AGENTCORE_PAYMENT_SESSION_ID", "PAYMENT_USER_EMAIL") if not os.environ.get(k)]
        if missing:
            print(f"live には provision の出力が要る: {', '.join(missing)}", file=sys.stderr)
            return 1

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    runner = Runner(args.plane)

    # MPP の有無を先に見る（402 だけ。支払わない）
    probe = httpx.get(args.url, timeout=30)
    offers_mpp = "payment " in (probe.headers.get("www-authenticate", "").lower() + " ")

    runs: List[Dict[str, Any]] = []
    with (out / "runs.jsonl").open("w", encoding="utf-8") as f:
        for i in range(1, args.n + 1):
            r = runner.once(args.url, i, "x402")
            runs.append(r)
            f.write(json.dumps(scrub(r), ensure_ascii=False) + "\n")
            print(json.dumps({k: r.get(k) for k in ("i", "http_status", "latency_ms", "error")}, ensure_ascii=False))
            if r.get("error"):
                break
        mpp_runs: List[Dict[str, Any]] = []
        mpp_url = args.mpp_url or (args.url if offers_mpp else None)
        if mpp_url:
            for i in range(1, args.n + 1):
                r = runner.once(mpp_url, i, "MPP")
                mpp_runs.append(r)
                f.write(json.dumps(scrub(r), ensure_ascii=False) + "\n")
                if r.get("error"):
                    break

    plugin = None if args.no_plugin else plugin_run(args.url, args.plane)

    def summarize(rs: List[Dict[str, Any]]) -> Dict[str, Any]:
        ok = [r for r in rs if r.get("delivered")]
        lat = [r["latency_ms"] for r in ok]
        return {
            "attempted": len(rs),
            "delivered": len(ok),
            "latency_ms_median": statistics.median(lat) if lat else None,
            "latency_ms_min": min(lat) if lat else None,
            "latency_ms_max": max(lat) if lat else None,
            "process_payment_ms_median": statistics.median([r["breakdown_ms"]["process_payment"] for r in ok]) if ok else None,
            "tx": [
                {
                    "tx_hash": (r.get("settlement") or {}).get("transaction"),
                    "settled_amount": (r.get("settlement") or {}).get("amount"),
                    "onchain_usdc": (r.get("onchain") or {}).get("usdc_transfers"),
                    "onchain_status": (r.get("onchain") or {}).get("status"),
                }
                for r in ok
            ],
            "errors": [r.get("error") for r in rs if r.get("error")],
        }

    from importlib.metadata import version

    summary = {
        "measuredAt": jst(time.time()),
        "plane": args.plane,
        "seller": args.url,
        "seller_offers_mpp": offers_mpp,
        "sdk": {"bedrock-agentcore": version("bedrock-agentcore"), "strands-agents": version("strands-agents")},
        "x402": summarize(runs),
        "mpp": summarize(mpp_runs) if mpp_url else {"executed": False, "reason": "売り手が MPP チャレンジを返さない"},
        "plugin": plugin,
    }
    (out / "summary.json").write_text(json.dumps(scrub(summary), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary["x402"], ensure_ascii=False)[:600])
    return 0 if summary["x402"]["delivered"] == args.n else 1


if __name__ == "__main__":
    raise SystemExit(main())

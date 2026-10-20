"""AC-1 D3: 支払い後に売り手が応答を遅らせ、クライアントがタイムアウトして再送したとき、
clientToken は使い回されるのか、新しく作られるのか。

2 つの経路で測る。
  (a) Strands プラグイン経由（examples/pay_with_strands.py と同じ構成）
      モデルは台本（ScriptedModel）。1 回目の http_request がタイムアウトしたら、
      もう一度同じ URL を http_request する（LLM エージェントがやりがちな動きを固定で再現）。
  (b) PaymentManager.generate_payment_header を直接呼ぶ経路
      b0: 同じ支払いヘッダをそのまま再送する
      b1: 402 を取り直し、client_token を渡さずに generate_payment_header をもう一度呼ぶ（SDK 既定）
      b2: 402 を取り直し、1 回目と同じ client_token を明示して呼ぶ

データプレーン:
  --plane=local … AgentCore を呼ばない（scripts/py/planes.py の LocalPlane）。
                  測れるのは「SDK / プラグインが ProcessPayment に何の clientToken を渡したか」と
                  「売り手側で何回決済が成立したか」まで。AgentCore 側の冪等性・予算は測れない。
  --plane=live  … 本物の AgentCore。上に加えて processPaymentId と残予算の変化を記録する。
                  要: AGENTCORE_PAYMENT_MANAGER_ARN / AGENTCORE_PAYMENT_INSTRUMENT_ID /
                      AGENTCORE_PAYMENT_SESSION_ID / PAYMENT_USER_EMAIL / AWS_REGION

前提: 模擬売り手が MOCK_SLOW_MS=30000（既定）で動いていること（/x402/slow）。

出力: artifacts/ac1/D3.json（--out で変更可）
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py"))
from planes import calls_to_json, install_local_plane, scrub, spy  # noqa: E402
from scripted_model import ScriptedModel  # noqa: E402

MOCK = os.environ.get("MOCK_BASE_URL", "http://127.0.0.1:8402")
SLOW_URL = f"{MOCK}/x402/slow"
TESTNET_PREFERRED = ["base-sepolia", "eip155:84532"]


def stats() -> Dict[str, int]:
    return httpx.get(f"{MOCK}/stats", timeout=5).json()["settlements"]


def settled_delta(before: Dict[str, int], after: Dict[str, int], path: str = "/x402/slow") -> int:
    return after.get(path, 0) - before.get(path, 0)


def fetch_402() -> Dict[str, Any]:
    r = httpx.get(SLOW_URL, timeout=10)
    try:
        body: Any = r.json()
    except Exception:  # noqa: BLE001
        body = {"text": r.text}
    return {"statusCode": r.status_code, "headers": dict(r.headers), "body": body}


def budget(manager: Any, session_id: str, user_id: Optional[str]) -> Optional[str]:
    try:
        s = manager.get_payment_session(payment_session_id=session_id, user_id=user_id)
        a = (s.get("availableLimits") or {}).get("availableSpendAmount") or {}
        return f"{a.get('value')} {a.get('currency')}" if a else None
    except Exception as e:  # noqa: BLE001
        return f"error:{type(e).__name__}"


def env_or(name: str, fallback: str) -> str:
    return os.environ.get(name) or fallback


# ------------------------------------------------------------------ (a) plugin
def run_plugin(live: bool) -> Dict[str, Any]:
    from bedrock_agentcore.payments.integrations.strands import (
        AgentCorePaymentsPlugin,
        AgentCorePaymentsPluginConfig,
    )
    from strands import Agent

    config = AgentCorePaymentsPluginConfig(
        payment_manager_arn=env_or("AGENTCORE_PAYMENT_MANAGER_ARN", "arn:aws:bedrock-agentcore:us-east-1:000000000000:payment-manager/local"),
        user_id=env_or("PAYMENT_USER_EMAIL", "local-user"),
        payment_instrument_id=env_or("AGENTCORE_PAYMENT_INSTRUMENT_ID", "local-instrument"),
        payment_session_id=env_or("AGENTCORE_PAYMENT_SESSION_ID", "local-session"),
        region=env_or("AWS_REGION", "us-east-1"),
        network_preferences_config=TESTNET_PREFERRED,
        auto_payment=True,
        auto_session=False,
        buyer_pays_gas_fees=False,
        agent_name="ac1-d3",
    )
    plugin = AgentCorePaymentsPlugin(config=config)
    model = ScriptedModel(
        [
            {"tool": "http_request", "input": {"url": SLOW_URL}},
            # 1 回目がタイムアウトしたので、エージェントが同じ URL をもう一度取りに行く
            {"tool": "http_request", "input": {"url": SLOW_URL}},
            {"text": "done"},
        ]
    )
    agent = Agent(model=model, plugins=[plugin], callback_handler=None)
    if live:
        calls = spy(plugin.payment_manager)
    else:
        plane = install_local_plane(plugin.payment_manager)
        calls = plane.calls

    before = stats()
    b0 = budget(plugin.payment_manager, config.payment_session_id, config.user_id) if live else None
    started = time.time()
    agent("SLOW_URL を取得して")
    elapsed = time.time() - started
    after = stats()
    b1 = budget(plugin.payment_manager, config.payment_session_id, config.user_id) if live else None

    tokens = [c.client_token for c in calls]
    return {
        "path": "strands-plugin",
        "planner": "scripted (1 回目のタイムアウト後に同じ URL を再度 http_request)",
        "plugin_http_timeout_s": 30.0,
        "post_payment_retry_delay_seconds": config.post_payment_retry_delay_seconds,
        "elapsed_s": round(elapsed, 1),
        "process_payment_calls": calls_to_json(calls),
        "client_tokens": tokens,
        "client_token_reused": len(tokens) >= 2 and len(set(tokens)) < len(tokens),
        "merchant_settlements": settled_delta(before, after),
        "tool_results_seen_by_model": model.seen_tool_results,
        **({"budget_before": b0, "budget_after": b1} if live else {}),
    }


# ------------------------------------------------------------------ (b) direct
def run_direct(live: bool, variant: str, client_timeout_s: float) -> Dict[str, Any]:
    from bedrock_agentcore.payments.manager import PaymentManager

    manager = PaymentManager(
        payment_manager_arn=env_or("AGENTCORE_PAYMENT_MANAGER_ARN", "arn:aws:bedrock-agentcore:us-east-1:000000000000:payment-manager/local"),
        region_name=env_or("AWS_REGION", "us-east-1"),
        agent_name="ac1-d3",
    )
    calls = spy(manager) if live else install_local_plane(manager).calls
    user_id = env_or("PAYMENT_USER_EMAIL", "local-user")
    session_id = env_or("AGENTCORE_PAYMENT_SESSION_ID", "local-session")
    instrument_id = env_or("AGENTCORE_PAYMENT_INSTRUMENT_ID", "local-instrument")

    def gen(req: Dict[str, Any], token: Optional[str]) -> Dict[str, str]:
        return manager.generate_payment_header(
            user_id=user_id,
            payment_instrument_id=instrument_id,
            payment_session_id=session_id,
            payment_required_request=req,
            network_preferences=TESTNET_PREFERRED,
            client_token=token,
        )

    attempts: List[Dict[str, Any]] = []

    def send(header: Dict[str, str], label: str) -> None:
        t0 = time.time()
        try:
            r = httpx.get(SLOW_URL, headers=header, timeout=client_timeout_s)
            attempts.append({"label": label, "http_status": r.status_code, "elapsed_s": round(time.time() - t0, 1),
                             "body": r.text[:200]})
        except httpx.TimeoutException:
            attempts.append({"label": label, "timeout": True, "elapsed_s": round(time.time() - t0, 1)})

    before = stats()
    b0 = budget(manager, session_id, user_id) if live else None
    fixed = "d3-fixed-" + os.urandom(12).hex()  # 33 文字以上（API の clientToken 制約）

    h1 = gen(fetch_402(), fixed if variant == "b2" else None)
    send(h1, "1st (timeout expected)")
    if variant == "b0":
        send(h1, "resend same header")
    else:
        h2 = gen(fetch_402(), fixed if variant == "b2" else None)
        send(h2, "regenerate & resend")
    after = stats()
    b1 = budget(manager, session_id, user_id) if live else None

    tokens = [c.client_token for c in calls]
    return {
        "path": f"generate_payment_header/{variant}",
        "variant": {
            "b0": "同じ支払いヘッダをそのまま再送",
            "b1": "402 を取り直し client_token 未指定で再生成（SDK 既定）",
            "b2": "402 を取り直し 1 回目と同じ client_token を明示して再生成",
        }[variant],
        "client_timeout_s": client_timeout_s,
        "process_payment_calls": calls_to_json(calls),
        "client_tokens": tokens,
        "client_token_reused": len(tokens) >= 2 and len(set(tokens)) < len(tokens),
        "http_attempts": attempts,
        "merchant_settlements": settled_delta(before, after),
        **({"budget_before": b0, "budget_after": b1} if live else {}),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--plane", choices=["local", "live"], default="local")
    ap.add_argument("--paths", default="plugin,b0,b1,b2")
    ap.add_argument("--client-timeout", type=float, default=10.0)
    ap.add_argument("--out", default="artifacts/ac1/D3.json")
    args = ap.parse_args()

    if any(k.upper().startswith("MAINNET") for k in os.environ):
        print("env に MAINNET_* がある。実マネー禁止のため停止する（scripts/py は src/guard/network.ts と同じ方針）",
              file=sys.stderr)
        return 2
    if httpx.get(f"{MOCK}/health", timeout=5).status_code != 200:
        print(f"模擬売り手 {MOCK} が動いていない", file=sys.stderr)
        return 1

    live = args.plane == "live"
    results: List[Dict[str, Any]] = []
    for p in args.paths.split(","):
        print(f"D3 {p} ({args.plane}) …", flush=True)
        try:
            results.append(run_plugin(live) if p == "plugin" else run_direct(live, p, args.client_timeout))
        except Exception as e:  # noqa: BLE001
            results.append({"path": p, "error": f"{type(e).__name__}: {e}"})

    from importlib.metadata import version

    record = {
        "case": "D3",
        "question": "売り手が支払い後に応答を 30 秒遅らせ、クライアントがタイムアウトして再送したとき、clientToken は使い回されるか",
        "plane": "agentcore" if live else "local-fake",
        "executed": True,
        "scope": (
            "AgentCore 本体の挙動（冪等性・予算）を含む" if live else
            "クライアント側（SDK / プラグイン）が渡す clientToken と、売り手側の決済回数まで。"
            "AgentCore の冪等性・予算は含まない（--plane=live で測る）"
        ),
        "sdk": {"bedrock-agentcore": version("bedrock-agentcore"), "strands-agents": version("strands-agents")},
        "mock_slow_ms": int(os.environ.get("MOCK_SLOW_MS", "30000")),
        "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "results": results,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(scrub(record), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for r in results:
        print(json.dumps({k: r.get(k) for k in ("path", "client_tokens", "client_token_reused",
                                                  "merchant_settlements", "error")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

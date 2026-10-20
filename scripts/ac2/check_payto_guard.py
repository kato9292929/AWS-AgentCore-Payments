"""AC-2: 支払い先 allowlist に無い payTo には署名に進まないことを示すテスト（Python / Strands 経路）。

TS 側（ハーネス）は scripts/run-all.ts の payto-not-allowlisted シナリオで同じことを見る。
ここでは examples/pay_with_strands.py の GuardedPaymentsPlugin を、AgentCore の代わりに
LocalPlane（scripts/py/planes.py）につないで、模擬売り手の 2 つの売り場を叩く。

  /x402/other-payto … payTo が allowlist に無い → ProcessPayment が 0 回、売り手の決済 0 回
  /x402/v2/weather  … payTo が allowlist にある  → ProcessPayment 1 回、200

使い方: npm run mock:merchant を起動したうえで
  python scripts/ac2/check_payto_guard.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "examples"))
sys.path.insert(0, str(ROOT / "scripts" / "py"))

from bedrock_agentcore.payments.integrations.strands import AgentCorePaymentsPluginConfig  # noqa: E402
from pay_with_strands import GuardedPaymentsPlugin  # noqa: E402
from payto_guard import PayToAllowlist  # noqa: E402
from planes import install_local_plane  # noqa: E402
from scripted_model import ScriptedModel  # noqa: E402
from strands import Agent  # noqa: E402

MOCK = os.environ.get("MOCK_BASE_URL", "http://127.0.0.1:8402")


def run(path: str) -> dict:
    cfg = AgentCorePaymentsPluginConfig(
        payment_manager_arn="arn:aws:bedrock-agentcore:us-east-1:000000000000:payment-manager/local",
        user_id="local-user",
        payment_instrument_id="local-instrument",
        payment_session_id="local-session",
        region="us-east-1",
        network_preferences_config=["base-sepolia", "eip155:84532"],
        auto_session=False,
        post_payment_retry_delay_seconds=0,
    )
    plugin = GuardedPaymentsPlugin(config=cfg, allowlist=PayToAllowlist.load())
    model = ScriptedModel([{"tool": "http_request", "input": {"url": f"{MOCK}{path}"}}, {"text": "done"}])
    agent = Agent(model=model, plugins=[plugin], callback_handler=None)
    plane = install_local_plane(plugin.payment_manager)
    before = httpx.get(f"{MOCK}/stats").json()["settlements"].get(path, 0)
    agent("go")
    after = httpx.get(f"{MOCK}/stats").json()["settlements"].get(path, 0)
    return {
        "path": path,
        "process_payment_calls": len(plane.calls),
        "merchant_settlements": after - before,
        "guard_log": plugin.guard_log,
        "last_tool_result": (model.seen_tool_results or [""])[-1][:160],
    }


def main() -> int:
    rejected = run("/x402/other-payto")
    allowed = run("/x402/v2/weather")
    checks = {
        "other-payto: ProcessPayment 0 回": rejected["process_payment_calls"] == 0,
        "other-payto: 売り手の決済 0 回": rejected["merchant_settlements"] == 0,
        "other-payto: guard が拒否を記録": bool(rejected["guard_log"]) and rejected["guard_log"][0]["allowed"] is False,
        "v2/weather: ProcessPayment 1 回": allowed["process_payment_calls"] == 1,
        "v2/weather: 売り手の決済 1 回": allowed["merchant_settlements"] == 1,
    }
    ok = all(checks.values())
    print(json.dumps({"check": "payto-guard (python/strands)", "result": "ok" if ok else "NG", "checks": checks,
                      "runs": [rejected, allowed]}, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

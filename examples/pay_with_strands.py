"""AgentCore payments の Strands プラグインで x402 を払う最小構成。

指示書の手順4に対応する。独自の買い手ハーネスは使わない。
402 の検出・署名・再送・上限はプラグインと AgentCore が持つ。

前提:
    pip install "bedrock-agentcore[strands-agents]"
    provision が済んでいて、以下が env に入っていること。
      AWS_REGION
      AGENTCORE_PAYMENT_MANAGER_ARN
      AGENTCORE_PAYMENT_INSTRUMENT_ID
      AGENTCORE_PAYMENT_SESSION_ID
      PAYMENT_USER_EMAIL

実行:
    python examples/pay_with_strands.py "<有料エンドポイントのURL>"

--------------------------------------------------------------------------
testnet に留めるための唯一の砦（重要）
--------------------------------------------------------------------------
AgentCorePaymentsPluginConfig.network_preferences_config の既定は None で、
None のときは SDK 内蔵の NETWORK_PREFERENCES にフォールバックする。
その既定リストは **mainnet が先頭** に並んでいる:

    NETWORK_PREFERENCES = [
        "solana-mainnet", ..., "eip155:8453"(Base mainnet), "eip155:1"(Ethereum mainnet),
        ..., "base-sepolia", "eip155:84532", ...
    ]
    出典: bedrock_agentcore/payments/constants.py（1.22.0、ローカル展開して確認）

売り手が mainnet と testnet の両方を提示した場合、既定のままだと mainnet の
チャレンジが選ばれる。独自ハーネスの allowlist ガードを外した以上、
testnet に留める保証はこの1行だけになる。**必ず明示すること。**
"""

import os
import sys

from bedrock_agentcore.payments.integrations.strands import (
    AgentCorePaymentsPlugin,
    AgentCorePaymentsPluginConfig,
)
from strands import Agent

# Base Sepolia のみ。ここに mainnet を混ぜない。
TESTNET_ONLY = ["eip155:84532"]


def require(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        sys.exit(f"環境変数 {name} が必要（provision の出力を入れる）")
    return v


def main() -> int:
    if len(sys.argv) < 2:
        sys.exit("使い方: python examples/pay_with_strands.py <有料エンドポイントのURL>")
    url = sys.argv[1]

    config = AgentCorePaymentsPluginConfig(
        payment_manager_arn=require("AGENTCORE_PAYMENT_MANAGER_ARN"),
        user_id=require("PAYMENT_USER_EMAIL"),
        payment_instrument_id=require("AGENTCORE_PAYMENT_INSTRUMENT_ID"),
        payment_session_id=require("AGENTCORE_PAYMENT_SESSION_ID"),
        region=os.environ.get("AWS_REGION", "us-east-1"),
        # ↓ これを省くと mainnet が優先される（冒頭の注意を参照）
        network_preferences_config=TESTNET_ONLY,
        # 402 を自動で処理する。False にすると 402 のまま返る（挙動確認用）
        auto_payment=True,
        # セッションは provision で明示的に作ってある。
        # True にすると上限 auto_session_budget（既定 "1.00" USD）で勝手に作られるので使わない。
        auto_session=False,
        # MPP でガス肩代わりを求められても署名しない（x402 では無視される）
        buyer_pays_gas_fees=False,
        agent_name="buyer-minimal",
    )

    # 注意: SDK 同梱の README の例は tools=[strands_tools.http_request] を渡しつつ
    # provide_http_request を既定(True)のままにしており、そのままだと
    # プラグイン内蔵の http_request と名前が衝突して ValueError になる。
    # ここでは外部ツールを渡さず、プラグイン内蔵の http_request だけを使う。
    agent = Agent(
        system_prompt="有料APIを呼べるアシスタント。取得した内容をそのまま報告する。",
        plugins=[AgentCorePaymentsPlugin(config=config)],
    )

    # 402 が返るとプラグインが ProcessPayment → 支払いヘッダ付きで再送する。
    result = agent(f"{url} を http_request で取得して、返ってきた内容をそのまま報告して。")
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

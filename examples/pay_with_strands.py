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
testnet に留める仕組みは「無い」（重要・実測）
--------------------------------------------------------------------------
network_preferences_config は **フィルタではなく並べ替えのヒント** でしかない。
manager._select_accept_for_instrument_network() を読むと分かる:

    Step 1: instrument のチェーン族（ETHEREUM/SOLANA）で accepts を絞る
            → _ETHEREUM_NETWORKS には mainnet も testnet も両方入っている。
              つまりこの段階で mainnet は落ちない。
    Step 2: network_preferences（未指定なら NETWORK_PREFERENCES）を使う
    Step 3: preferences の順に、一致する accept を返す
    Step 4: **一致しなければ filtered_accepts[0] を返す**  ← ここが穴

実測（bedrock-agentcore 1.22.0 を venv に入れて直接呼んだ結果）。
売り手が [Base mainnet, base-sepolia] の順に提示した 402 に対して:

    既定 (None)                      -> eip155:8453   (Base mainnet)
    ["eip155:84532"] だけ指定        -> eip155:8453   (Base mainnet)   ← 効かない
    ["base-sepolia", "eip155:84532"] -> base-sepolia                    ← 効く
    売り手が mainnet しか出さない場合 -> eip155:8453   (Base mainnet)   ← 防げない

2 番目が効かないのは、x402 の 402 応答が network を slug（"base-sepolia"）で
返すのに対し、CAIP-2 表記（"eip155:84532"）だけを渡すと文字列比較が一致せず、
Step 4 のフォールバックに落ちるため。**両方の表記を入れること。**

4 番目が本質的な限界。売り手が mainnet しか提示しなければ、
このプラグイン構成では mainnet で払う。**SDK 側に testnet 強制は存在しない。**

したがって実マネーを防ぐのは、この設定ではなく次の 2 つになる:
  (1) 相手を testnet 専用の売り手に限定する（叩く URL を人間が選ぶ）
  (2) ウォレットに testnet USDC しか入れない（mainnet 残高ゼロなら決済が失敗する。
      ただし「拒否」ではなく「失敗」なので、防御としては弱い）

それ以上の拘束が要るなら、auto_payment=False にして 402 を自前で検査する
＝ このリポジトリの src/guard/network.ts（allowlist・deny by default）に戻ることになる。
"""

import os
import sys

from bedrock_agentcore.payments.integrations.strands import (
    AgentCorePaymentsPlugin,
    AgentCorePaymentsPluginConfig,
)
from strands import Agent

# slug と CAIP-2 の両方を入れる。片方だけだと文字列比較が外れて
# Step 4 のフォールバック（＝先頭の accept、mainnet になりうる）に落ちる。
# これは「優先順」であって「制限」ではない（冒頭の注意を参照）。
TESTNET_PREFERRED = ["base-sepolia", "eip155:84532", "sepolia", "eip155:11155111"]


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
        # 省くと mainnet が優先される。指定しても mainnet を「禁止」はできない。
        network_preferences_config=TESTNET_PREFERRED,
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
    print(
        "注意: network_preferences_config は優先順であって制限ではない。\n"
        "      売り手が mainnet しか提示しなければ mainnet で払う。\n"
        f"      叩く先が testnet 専用であることを確認してから続けること: {url}\n"
    )

    result = agent(f"{url} を http_request で取得して、返ってきた内容をそのまま報告して。")
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

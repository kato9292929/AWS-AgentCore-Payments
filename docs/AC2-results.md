# AC-2 結果: Coinbase 経路での実払いの一周（T4/T5）

生成: 2026-10-20T17:42:53+09:00（`npx tsx scripts/report.ts`。値は artifacts/ac2/ からのみ取る）

```
項目                     値                                                            状態
-----------------------  ------------------------------------------------------------  ---------------------------------------------------------
売り手                   https://x402.org/protected（x402 v2 exact, eip155:84532, $0.01）  選定済み（2026-10-20 の 402 で確認）
支払い先 allowlist       config/payto-allowlist.json 以外の payTo には署名しない       実測（テスト: run-all payto-not-allowlisted / check:py）
402→200 の時間（10 回）  -                                                             未実施（AgentCore の資格情報なし）
settle の tx と金額      -                                                             未実施（AgentCore の資格情報なし）
MPP                      x402.org は MPP チャレンジを返さない                          未実施（testnet で MPP を返す公開売り手が見つからない）
Strands プラグイン経由   -                                                             未実施（AgentCore の資格情報なし）
CloudWatch の項目名      -                                                             未実施（AgentCore の資格情報なし。docs 記載の名前は下に）
```

## 売り手の選定

| 候補 | 402 | 採否 |
|---|---|---|
| **https://x402.org/protected** | v2 / `PAYMENT-REQUIRED` ヘッダ / exact / eip155:84532 / 10000（$0.01）/ payTo 0x209693Bc…287C / extra {name:"USDC",version:"2"} / Solana devnet の accept も併記 | **採用**。x402 の仕様リポジトリを持つ x402.org が運営、testnet 専用、少額 |
| https://x402.payai.network/api/base-sepolia/paid-content | v2 exact eip155:84532 $0.01 | 予備 1 |
| https://x402.nodeventures.io/check | v2 exact eip155:84532 $0.005 | 予備 2（小規模の第三者） |

egress に必要なホストは `x402.org` だけ（再送も同じホスト。settle は売り手側の facilitator が行う）。
オンチェーン照合に `sepolia.base.org`（Base Sepolia の公開 RPC）を使う。

## 未実施の理由と、埋める手順

AWS の資格情報（env にあるものは `InvalidClientTokenId`）と provision の出力が無いため、ProcessPayment を呼べていない。
結線は AgentCore の代わりに LocalPlane（`scripts/py/planes.py`。EIP-3009 を実署名）をつないで、模擬売り手の v2 売り場で一周させて確認済み
（`python scripts/ac2/run.py --plane=local --url=http://127.0.0.1:8402/x402/v2/weather --n=3 --out=/tmp/ac2-selftest`）。これは実測ではないので artifacts には置いていない。

```bash
python scripts/ac2/cloudwatch.py --setup                     # vended logs の delivery（初回だけ）
python scripts/ac2/run.py --url=https://x402.org/protected --n=10
python examples/pay_with_strands.py --scripted https://x402.org/protected   # 指示書どおりの 1 周（LLM 無し）
python scripts/ac2/cloudwatch.py --collect
npx tsx scripts/report.ts
```

## CloudWatch（docs 記載。実物の名前は cloudwatch.json で上書きする）

- メトリクス: OperationSuccess, OperationFailure, OperationLatency, SpendAmount, Throttles, UserErrors, ActiveSessions,
  PaymentRequestCount, PaymentSuccessCount, PaymentFailureCount, PaymentLatency
- ディメンション: Operation, PaymentManagerId, PaymentConnectorId, AgentName, Currency
- 名前空間: payments のページに明記なし（AgentCore 全般は `AWS/Bedrock-AgentCore`）。`cloudwatch.py` は名前空間を決め打ちせず
  PaymentManagerId ディメンションで引く
- vended logs: 既定のロググループ無し。フィールド名は docs に無い（`cloudwatch.py --collect` で実物のキーを集める）
- スパン: `Bedrock.AgentCore.Payments.<Operation>`、属性 `aws.payments.*`（spend_amount, session_remaining_budget, merchant ほか）

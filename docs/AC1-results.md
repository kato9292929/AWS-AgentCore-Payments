# AC-1 結果: ProcessPayment の冪等性と、支払いを止める条件

生成: 2026-11-24T15:02:13+09:00（`npx tsx scripts/report.ts`。値は artifacts/ac1/*.json からのみ取る）

```
ケース  内容                                                確かめること                                              区分                  値
------  --------------------------------------------------  --------------------------------------------------------  --------------------  ------------------------------------------------------------
D0      最初の 1 回（Base Sepolia exact $0.05）             PROOF_GENERATED か／応答の項目名／残高ゼロで署名できるか  実測                  status=PROOF_GENERATED / 項目 ["createdAt","paymentInstrumentId","paymentManagerArn","paymentOutput","paymentSessionId","paymentType","processPaymentId","status","updatedAt"] / paymentOutput 直下 ["cryptoX402"]
D1      同じ 402・同じ clientToken で 2 回                  2 回目が同じ processPaymentId か／予算は 1 回分か         実測                  同じID=true / 予算減 1回目 0.010000 2回目 0.000000
D2      同じ 402・別の clientToken で 2 回                  2 回とも署名されるか／予算が 2 回分減るか                 実測                  両方署名=true / 別ID=true / 予算減 0.010000, 0.010000
D3      支払い後に売り手が 30 秒遅延→タイムアウト→再送      プラグインは clientToken を使い回すか新しく作るか         オフライン想定のまま  プラグイン: 毎回新規（token 2種/2回・売り手の決済 2 回） / 直接 b1(未指定): 新規（2種/2回・決済 2 回） / b2(明示): 同一（1種/2回） / b0(ヘッダ再送): 決済 1 回 ［local-fake: AgentCore 側の冪等性・予算は未測定］
D4      セッション上限 $0.20 に $0.05 を 5 回（v1, slug）   5 回目が拒否されるか／拒否時のエラー型                    実測                  最初の拒否=5回目 / ValidationException(400): Insufficient budget for session payment-session-CZn7e6VLDGPx
D4h     D4 をハーネス --guards=agentcore-only で            自前ガードを外しても AgentCore だけで止まるか             未実施                未実施（今回の実行範囲外。資格情報がそろう前の記録のまま）
D5      セッション有効期限切れの後に呼ぶ                    拒否されるか／エラー型                                    実測                  拒否=true / ValidationException: Payment session not found: payment-session-5xOgRRefZq7bEEr
D6      MPP: 期限切れのチャレンジ                           ValidationException になり予算が減らないか                未実施                未実施（今回の実行範囲外。資格情報がそろう前の記録のまま）
D7      MPP: feePayer=false で buyerPaysGasFees を渡さない  ValidationException になるか                              未実施                未実施（今回の実行範囲外。資格情報がそろう前の記録のまま）
D8      testnet（eip155:84532, v2）で D4                    セッション上限が testnet でも効くか                       実測                  最初の拒否=5回目 / ValidationException(400): Insufficient budget for session payment-session-HBfbIJusOHps
```

## 読み方

- ProcessPayment は AWS SDK で**直接**呼ぶ（`scripts/ac1/run.ts`）。ハーネスの自前ガード（$0.05 / $0.20）は通らないので、
  D1〜D8 の拒否はすべて AgentCore 側の挙動になる。D4h だけはハーネス経由で `--guards=agentcore-only` にしたもの。
- 402 は模擬売り手（`mock/server.ts`）から取る。売り手への再送はしない（D3 を除く）。売り手側の egress も入金も要らない。
- 残予算は `GetPaymentSession` の `availableLimits.availableSpendAmount`（呼ぶ前・呼んだ後）。
- 未実施のケースにも、送るはずだった入力（`plannedInputs`）を artifacts/ac1/<case>.json に残してある。

## D3 の詳細（local-fake）

測った範囲: クライアント側（SDK / プラグイン）が渡す clientToken と、売り手側の決済回数まで。AgentCore の冪等性・予算は含まない（--plane=live で測る）

| 経路 | ProcessPayment に渡った clientToken | 使い回し | 売り手で成立した決済 |
|---|---|---|---|
| strands-plugin | `2b681933-002e…`, `8c90798a-fdd8…` | false | 2 |
| generate_payment_header/b0（同じ支払いヘッダをそのまま再送） | `cb1f4e71-9e24…` | false | 1 |
| generate_payment_header/b1（402 を取り直し client_token 未指定で再生成（SDK 既定）） | `838f1612-c7e9…`, `b724b136-ab60…` | false | 2 |
| generate_payment_header/b2（402 を取り直し 1 回目と同じ client_token を明示して再生成） | `d3-fixed-9225…`, `d3-fixed-9225…` | true | 2 |

- SDK {"bedrock-agentcore":"1.24.2","strands-agents":"1.61.1"}。プラグインの `_process_payment_required_request` は呼ぶたびに `client_token=str(uuid.uuid4())` を渡す
  （bedrock_agentcore/payments/integrations/strands/plugin.py）。`generate_payment_header` も未指定なら毎回 `uuid4()` を作る。
- プラグインの `http_request` は httpx の timeout 30 秒固定。30 秒遅れる売り手に対しては 1 回目の再送がタイムアウトし、
  `statusCode: 0` がモデルに返る。402 ではないのでプラグインは再署名しない。**モデルがもう一度 http_request を呼ぶと、
  新しい 402 に対して新しい clientToken で ProcessPayment が走る**（台本で再現。売り手では 2 回決済が成立した）。
- b0（同じヘッダをそのまま再送）は売り手が `nonce_already_used` で 402 を返し、二重決済にならない。
- b2 で売り手の決済が 2 回になっているのは local-fake が毎回署名し直すため。AgentCore が同じ clientToken に同じ証明を返すなら
  （＝D1 が「同じID」なら）、2 回目の再送は b0 と同じく nonce 使用済みで拒否されるはず。live で確かめる項目。

## D4h（ハーネス経由・agentcore-only）

未実施（資格情報／provision の出力が無い）

## 実行環境（実測）

- 2026-11-23、リージョン ap-southeast-2（日本の住所で作られたアカウントはシドニーに固定される。AWS アカウントの docs: project-regions）
- Payment Manager `paymentmanagermum7-r36kpioyxh`、Coinbase CDP connector `coinbase1-wubbi6q4wk`（Quick Create を API で作成）、
  instrument は EMBEDDED_CRYPTO_WALLET / ETHEREUM、WalletHub で署名許可済み、**入金なし（USDC 残高 0）**
- 資格情報の確認は artifacts/ac1/preflight.json、ウォレット作成までの経過は artifacts/ac1/provision.json
- CloudWatch のメトリクス名は artifacts/ac1/cloudwatch.json（vended logs は配信先が未設定のため 0 件）

## 偽クライアント・オフライン想定と実測で違った点

| 項目 | オフラインの想定（偽クライアント・docs） | 実測 | 対応 |
|---|---|---|---|
| 予算が減る時点 | 想定なし（LocalPlane は予算を再現していなかった）。ハーネスの自前ガードは売り手の 200 の後に計上 | **ProcessPayment で証明を作った時点**で減る。売り手への再送・settle を待たない（D4: 0.15→0.1→0.05→0） | LocalPlane を実測に合わせた。ハーネスの計上時点との差は記録のみ |
| 予算超過のエラー型 | docs に明記なし（ServiceQuotaExceeded 402 か、と推測していた） | **ValidationException（HTTP 400）** "Insufficient budget for session … Pending amount: 0 USD, Transaction amount: 0.050000 USD" | LocalPlane が同じ型・同じ文言で投げるようにした |
| 同じ clientToken の再送 | LocalPlane は毎回署名し直していた（D3 b2 の決済 2 回はそのため） | **同じ processPaymentId、予算は 1 回分**（D1） | LocalPlane に clientToken ごとの応答キャッシュを入れた |
| 応答の形 | LocalPlane は `processPayment` で包んで返していた | トップレベルに createdAt / paymentInstrumentId / paymentManagerArn / paymentOutput / paymentSessionId / paymentType / processPaymentId / status / updatedAt | LocalPlane を実物と同じ形にした（`python3 scripts/py/check_local_plane.py` で照合） |
| 残予算の取得 | LocalPlane は残予算を返さなかった | GetPaymentSession の availableLimits.availableSpendAmount（値は "0.2" のように末尾の 0 なし） | LocalPlane が同じ形で返すようにした |
| 残高ゼロでの署名 | docs: 「入金と許可の両方が済むまで支払い処理は失敗する」 | **入金なしでも PROOF_GENERATED**（許可は済み） | 記録のみ（売り手側の settle は残高不足で失敗するはず。未確認） |
| セッション期限切れ | Python SDK は文言に "expired" があれば PaymentSessionExpired に分類する作り。docs に型の明記なし | **ValidationException（HTTP 400）"Payment session not found: …"**。GetPaymentSession は ResourceNotFoundException。期限切れは「存在しない」扱い（D5） | LocalPlane が同じ動きをするようにした |
| status の値 | SDK 3 系は PROOF_GENERATED のみ／quick start は PENDING/SUCCESS/FAILED | **PROOF_GENERATED** | paymentStatus.ts の分類のままで合う |
| サービスロールの権限 | docs: connector を追加すると per-connector 権限が自動で付く | 登録情報の差し替え（Privy）・API での connector 追加（Coinbase）では**付かなかった**。本人が IAM で追加して解消 | provision.json と docs/T4-T5-blocked.md に記録 |
| CloudWatch のメトリクス名 | docs: PaymentRequestCount / PaymentSuccessCount / PaymentFailureCount / PaymentLatency ほか | 実際に出たのは ActiveSessions / OperationFailure / OperationLatency / OperationSuccess / PaymentTokenFetchFailures / PaymentTokenFetchSuccess / SpendAmount / Throttles / TransactionCount / UserErrors | cloudwatch.json に記録 |

## live で埋めるときの手順

```bash
npm run mock:merchant &                        # 別ターミナル
export AWS_REGION=us-east-1 AGENTCORE_PAYMENT_MANAGER_ARN=... AGENTCORE_PAYMENT_INSTRUMENT_ID=... \
       AGENTCORE_PAYMENT_SESSION_ID=... PAYMENT_USER_EMAIL=...
npm run ac1                                    # D1 D2 D4 D4h D6 D7 D8
npm run ac1 -- --cases=D5                      # 16 分待つ
python scripts/ac1/d3_client_token.py --plane=live
npx tsx scripts/report.ts
```

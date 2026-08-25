# 構想記事の実測差し替え用メモ

計画値・推測で書いてある箇所を、本セッションの実測に置き換えるための一覧。
「置換後」は artifacts の実ログから取れる文言だけを書いてある。
**未取得・未検証の欄を、埋まったことにして書かないこと。**

## A. 置き換えられる（実測がある）

| # | 計画側の書き方 | 置換後（実測） | 出典 |
|---|---|---|---|
| A1 | 「AgentCore は x402 と MPP の両方に対応」 | 一次確認済み。`PaymentType` enum が `CRYPTO_X402` / `MPP` の2値。ただし1回の `ProcessPayment` はどちらか片方（union） | `docs/T1-agentcore-findings.md` §1 |
| A2 | 「AgentCore が決済してくれる」 | **誤り。** `PaymentStatus` の値は `PROOF_GENERATED` のみ。AgentCore が返すのは署名済みの支払い証明までで、402 への再送とオンチェーン決済は外側に残る | 同 §4 |
| A3 | 「上限はインフラ層で強制できる」 | 半分だけ正しい。`SessionLimits.maxSpendAmount` は**セッション累計のみ**、通貨は `USD` 固定。**1回あたり上限に対応する API パラメータは無い** | 同 §3 |
| A4 | 「testnet で試せる」 | `BlockchainChainId` の testnet 値は `BASE_SEPOLIA` と `SOLANA_DEVNET` の2つ | 同 §2 |
| A5 | 「AWS だけで完結する」 | **誤り。** 買い手ウォレットは `PaymentConnectorType` = `CoinbaseCDP` か `StripePrivy` のコネクタ配下。Coinbase か Stripe のクレデンシャルが要る | 同 §6 |
| A6 | 「モデルに見せるツールは2つで足りる（想定）」 | 実測で成立。`TOOL_DEFS` は長さ2、3つ目は `dispatchTool` が拒否。402の一周・上限・承認は全部 `pay` の内側に入った | `artifacts/*/events.jsonl` の `session.start.tool_count=2`、`npm run check:tools` |
| A7 | 「上限を超えたら止まる（想定）」 | 実測。`$0.50` の要求に対し per_call_max `$0.05` で `declined(limit_exceeded)`、**再送のHTTPリクエストが1件も出ていない** | `artifacts/limit-exceeded/events.jsonl` |
| A8 | 「人間承認を残す（想定）」 | 実測。承認ログに 誰が・いつ・いくら。否認したまま決済が起きた事例ゼロ | `artifacts/cli-approval-denied`, `artifacts/not-approved` |
| A9 | 「MPP は x402 より複雑（想定）」 | 買い手から見ると**逆**。MPP は 402 の `WWW-Authenticate` を verbatim で渡すだけ（`MppPaymentInput.wwwAuthenticateHeaders`）。x402 は payload を自分で組み立てて渡す。<br>ただし MPP は金額が base64url(JCS JSON) の中にあるので、**上限判定のためには結局パースが要る** | `docs/T1-agentcore-findings.md` §5、`src/rails/mpp.ts` |
| A10 | 「ガス代の扱い」 | `MppPaymentInput.buyerPaysGasFees` があり、**省略・false は「ガス肩代わりを拒否する」意思表示**。チャレンジがガスを sponsor しない場合、false のままだと ValidationException で止まる。本ハーネスは明示 false | 同 §5 |

## B. 置き換えられない（未取得・未検証のまま書く）

| # | 項目 | 現状 | 記事での書き方 |
|---|---|---|---|
| B1 | 公開 testnet エンドポイントへの実払い一周 | **未実施**。x402.org / mpp.dev とも egress 403 | 「本セッションでは公開エンドポイントに到達できず、模擬売り手に対する一周のみ」と明記する |
| B2 | AgentCore `ProcessPayment` の実行 | **未実行**。コントロールプレーンの資格情報が無く payment manager を作れない | 「API 形状は一次確認済み、実行は未達」 |
| B3 | 料金・リージョン提供状況 | **未確認**。料金ページに到達不可 | 数字を書かない |
| B4 | `upto`（従量）スキーム | **未検証**。`exact` のみ実装 | 「GA で追加されたが本作業では触っていない」 |
| B5 | Coinbase Bazar MCP（GA で追加の x402 エンドポイント集） | **未確認** | discover の候補源として名前だけ挙げ、中身は書かない |
| B6 | 案1（`na4b6acb98907`）の実測値 | **未取得**。note.com に到達不可 | 6軸表の案1列は空欄のまま。埋めてから公開する |

## C. 記事の骨に効く発見（計画時に無かった論点）

1. **AgentCore を入れても層3（人間承認）は自分で書く**。
   API に承認ゲートに相当する概念が見当たらない。`userId` / `agentName` は
   observability 用のラベル。「判断の責任」は誰も肩代わりしてくれない。

2. **per_call 上限が無いのは効く**。エージェント決済で怖いのは
   「1回$100」より「$0.01 を 10万回」だが、AgentCore が持つのは累計側だけ。
   逆に言うと**累計はインフラが見てくれる**ので、自分で書くべきは1回あたりと承認点。

3. **依存が1つ増える**。AWS に寄せると Coinbase/Stripe が消えるのではなく、
   AWS + コネクタ提供元の2段になる。「AWS だけで完結」は書けない。

4. **買い手ハーネスの分界点**。AgentCore は「鍵と署名」を持つ。
   402 の解釈・上限・承認・再送は買い手側に残る。
   売り手側エッジ（CloudFront/WAF の x402、`nde1375fd27c9`）とは別物という
   注記は正しかったが、**買い手側でも AgentCore が担うのは一部**という点は
   計画時より踏み込んで書ける。

---

# 追記（2026-08-25）: GA を踏まえた差し替え

出典の区分:
**[SDK実測]** = このセッションで SDK の生成モデルを読んで確認（`npm run check:ga` が再現）
**[指示書経由]** = 開発指示書が AWS 公式 docs から引いた値。**本セッションでは未検証**（docs は egress 許可外）

## A（置き換えられる・根拠あり）追加分

| # | 計画側の書き方 | 置換後 | 区分・出典 |
|---|---|---|---|
| A11 | 「AgentCore payments は preview」 | GA は 2026-08-18。preview は 2026-04 | [指示書経由] |
| A12 | 「AgentCore はカストディを提供する」 | **誤り。AgentCore はオーケストレーション。** 鍵の安全は下の CoinbaseCDP / StripePrivy が担い、AgentCore 単体では担保しない。コネクタ無しでは買い手ウォレットを作れない | [SDK実測]（`PaymentConnectorType` / `PaymentCredentialProviderVendorType` が両方とも `CoinbaseCDP` \| `StripePrivy`）|
| A13 | 「per-call 上限はいずれ入るだろう」 | **GA 後の SDK 3.1117.0 にも無い。** `SessionLimits.maxSpendAmount` はセッション累計のみ、通貨 `USD` 固定 | [SDK実測] |
| A14 | 「AWS 側の従量課金が読めない」 | AgentCore payments 自体は AWS 追加課金なし。費用はウォレット提供元の**件数課金**（CDP 約 $0.005/op、`ProcessPayment` 1 回 = 1 op） | [指示書経由・未検証] |
| A15 | 「上限を超えたら止まる」（A7 の続き） | どの規則で止まったかまで出せるようになった。**セッション累計に余裕があっても per_call だけで decline する**ことを分離して実測（`artifacts/per-call-only`）。ログに `rule: "per_call_max"` と `enforced_by: "harness-only (AgentCore に該当 API 無し)"` が残る | 本リポジトリ実測 |
| A16 | 「承認は都度」 | **承認に金額の天井を付けた。** $0.01 を承認しても同一オリジンの $0.03 は再度聞く（`artifacts/grant-scope-exceeded`）。「一度払ったオリジンは以後ノーチェック」という前の実装の穴を塞いだ | 本リポジトリ実測 |

## B（未確認のまま書く）追加分

| # | 項目 | 現状 | 記事での書き方 |
|---|---|---|---|
| B7 | `ProcessPayment` の status | **一次情報どうしが食い違っている。** GA 後の SDK は `PROOF_GENERATED` 単一、GA docs は `PENDING/SUCCESS/FAILED` | 「どちらが現行か確定していない」と書く。片方を断定しない |
| B8 | `SUCCESS` 時点でオンチェーン確定しているか | **未確認**。買い手再送が要るかどうかがこれで決まる | 「AgentCore が返すのは証明までで、再送は買い手」と書けるのは `PROOF_GENERATED` を前提にした場合だけ、と留保を付ける |
| B9 | MPP の `paymentType` enum 値 | SDK は `MPP`、GA quick start は `CRYPTO_X402` のみ記載 | SDK 側の値を書き、docs 未確認と添える |
| B10 | ProcessPayment payload の network 表記 | CAIP-2（`eip155:84532`）か slug（`base-sepolia`）か未確定 | 書かない。実装は両対応にしてある |
| B11 | `AWS_MARKETPLACE_SUBSCRIPTION_REQUIRED` | コネクタ status に存在する [SDK実測] が、どのコネクタで必要になるかは未確認 | 存在だけ触れて条件は書かない |

## C（計画時に無かった論点）追加分

5. **一次情報が 1 つとは限らない。**
   GA 後に出た SDK の enum と、GA docs の enum が食い違っている。
   「公式ドキュメントに書いてある」と「API が実際に受ける」は別物で、
   **どちらか片方に寄せて実装すると、もう一方の環境で壊れる。**
   本ハーネスは status を不透明な文字列として扱い、分類だけを 1 箇所に寄せ、
   未知の値は停止側に倒した。エージェント決済のように
   「間違えると金が動く」領域では、この倒し方は書く価値がある。

6. **プロビジョニングには人手が 2 回入る。**
   コネクタの OAuth 同意（`PENDING_AUTHENTICATION` → `authorizationUrl`）と、
   instrument の入金（`redirectUrl`）。**「エージェントが自律的に決済する」までの
   前段は、人間が 2 回ブラウザを開く作業**である。ここは自動化されていない。
   三層の C（判断の責任）が、実は運用の入口にも残っている。

7. **件数課金は少額決済の話を変える。**
   料金が取引額の％ではなく件数なら、$0.001 の支払いに $0.005 の op 費用がかかる。
   per-call 上限は「使いすぎ防止」だけでなく「1 件あたりの原価割れ防止」の意味を持つ。
   [指示書経由・未検証] なので、記事に数字を出すなら料金ページの再確認が要る。

8. **再送を 1 回に切る判断。**
   402 が返り続けるとき、署名し直して投げ直すと同じ金額を二度払う事故になりうる。
   本ハーネスは**再送を既定 1 回**にし、402 で返されたら再署名しない。
   `clientToken` を demand ごとに固定して AgentCore の冪等性にも載せている。
   「リトライは親切」ではなく「リトライは支出」という向きの話。

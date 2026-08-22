# T9: 案1（Hermes / mpp-agent / mpp.dev）と本案（AWS AgentCore payments）の6軸比較

## 埋め方の規則

- **実測**＝本セッションで実際に走らせて採れた値。`artifacts/` の該当ログを併記する。
- **未実装**＝コードは書いたが実行できていない。止まった場所を書く。
- **未確認**＝一次情報に当たれていない。推測で埋めない。
- 案1 の列は、**本セッションから note.com に到達できない**（egress 403）ため、
  指示書本文が明示している範囲だけを書き、それ以外は「未取得」にしてある。
  記事 `na4b6acb98907` を参照できる環境で埋めること。

## 6軸

| # | 軸 | 案1: Hermes mpp-agent × mpp.dev | 本案: AWS AgentCore payments |
|---|---|---|---|
| 1 | **鍵保管（層1 / 問題A）**<br>秘密鍵を誰が持ち、モデルからどう隠すか | 未取得（記事参照が必要）。指示書の記載は「同じ三層ガードレール」まで | **未実装（実行できていない）**。設計上は `EMBEDDED_CRYPTO_WALLET` を Coinbase CDP / Stripe Privy コネクタ配下に置き、鍵は AWS 側。ハーネスは `paymentInstrumentId` しか持たない。<br>本セッションの実測は代替バックエンド（プロセス内一時鍵）で、`proofSource: "local-signer"`。<br>ログへの鍵混入ゼロは実測（`npm run check:secrets` → 16ファイル200レコード走査で0件） |
| 2 | **上限の強制点（層2 / 問題B）**<br>金額をどこで機械的に拘束するか | 未取得 | **実測 + 一次確認**。AgentCore の `SessionLimits.maxSpendAmount` は**セッション累計のみ**、通貨は `USD` 固定。1回あたり上限に対応するAPIは無い。<br>→ ハーネス側（`src/guard/limits.ts`）に per_call $0.05 / session $0.20 を持ち、累計は AgentCore にも同値を渡して二重化。<br>超過時に再送が発生しないことを実測（`artifacts/limit-exceeded`, `artifacts/session-cap-exceeded`） |
| 3 | **人間承認（層3 / 問題C）**<br>どこに人間の判断が残るか | 未取得。指示書は「都度承認で判断の責任Cを残す方針」とする | **実測**。承認点は2つ（初回エンドポイント／上限超過）。自動承認は既定オフ。<br>承認ログに 誰が・いつ・いくら（`approval.decision`）。<br>否認したまま決済が起きた事例ゼロ（`artifacts/not-approved`, `artifacts/cli-approval-denied`） |
| 4 | **対応レール**<br>x402 / MPP をどう扱うか | 未取得（MPP 側の一周は記事にあるはず） | **一次確認済み**。`PaymentType` enum が `CRYPTO_X402` と `MPP` の両方を持つ。1回の `ProcessPayment` はどちらか片方。<br>MPP は 402 の `WWW-Authenticate` を verbatim で渡すだけでよい（パースは AgentCore 側）。x402 は payload を組み立てて渡す。<br>GA で `upto`（従量）スキームが追加されているが**未検証**（本作業は `exact` のみ） |
| 5 | **1周の実測**<br>402 → pay → success をどこまで採れたか | 未取得。指示書は「testnet 実払いを一周した記録」とする | **公開エンドポイントに対しては未実施**。x402.org / mpp.dev とも egress 403（`artifacts/live-attempt`）。<br>AgentCore `ProcessPayment` も未実行（コントロールプレーンの資格情報が無く payment manager を作れない。`artifacts/agentcore-attempt`）。<br>**ローカル模擬売り手に対しては両レールとも一周を実測**（x402: `artifacts/x402-success`、MPP: `artifacts/mpp-success`）。署名検証は本物、オンチェーン決済はしていない |
| 6 | **実マネー到達性と実費**<br>本番に持っていくとき何が要るか | 未取得 | **未確認（料金ページに到達不可）**。判明している必要条件: ①コントロールプレーンを叩ける AWS 資格情報 ②**Coinbase CDP または Stripe Privy のクレデンシャル**（AWS だけでは足りない）③ base-sepolia の testnet USDC。<br>本セッションの AWS 実費は **$0**（課金される API 呼び出しに到達していない）。<br>mainnet ガードは実測（`artifacts/mainnet-halt` で exit=2 停止） |

## この比較から言えること・言えないこと

**言えること**

- AgentCore payments は「決済を全部やってくれる箱」ではない。返すのは `PROOF_GENERATED`
  までで、**402 の一周（再送）とオンチェーン決済は外側に残る**。三層のうち
  AgentCore が引き受けるのは層1（鍵保管）と、層2の一部（セッション累計上限）だけ。
- **1回あたり上限は AgentCore に無い**。per_call を効かせたいなら、案1と同じく
  自分でラッパーを書くことになる。ここは「AWS に載せ替えても消えない仕事」。
- 層3（人間承認）は AgentCore に対応する概念が API に見当たらない。
  `userId` と `agentName` は observability 用のラベルで、承認ゲートではない。
  **判断の責任は、どちらの実装でも自分で残すしかない。**
- AgentCore を使うには Coinbase か Stripe のクレデンシャルが要る。
  「AWS に寄せると依存が減る」わけではなく、**依存先が1つ増える**。

**言えないこと**

- どちらが速い・安いは言えない。実費が測れていない。
- 実紛争・返金・レシートの法的な扱いは両案とも未検証。
- 2経路・模擬売り手1つの結果なので、エンドポイント差・チェーン差の一般化はできない。

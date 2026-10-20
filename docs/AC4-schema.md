# AC-4: 計測ログの書式

AA（x402 Autonomous Agent）が週次で払っている第三者の売り手と同じ相手に、AgentCore 経由で払ったときの
実費・上乗せ・失敗率・遅延を、**同じ項目名で**横に並べるための書式。1 行 = 1 回の支払い試行（probe は 1 行 = 1 つの accept）。

## 項目

```
項目               型              意味
-----------------  --------------  ---------------------------------------------------------------------------
timestamp          string          試行を始めた時刻。JST の ISO 8601（例 2026-10-20T15:01:37+09:00）
seller_host        string          売り手のホスト名（URL の host。パスは含めない）
protocol           "x402"|"MPP"    402 のどちらに応じたか
scheme             string          x402: exact / upto / batch-settlement。MPP: <method>/<intent>（例 tempo/charge）
network            string          CAIP-2（eip155:84532, eip155:8453, solana:...）。x402 v1 の slug は CAIP-2 に読み替える
price              string|null     402 で提示された額（USD、小数 6 桁）。upto は上限額。USDC 以外で換算できなければ null
settled_amount     string|null     実際に決済された額（USD）。売り手の settlement 応答の amount、無ければオンチェーンの
                                   USDC Transfer。未決済・不明なら null
gas                string|null     買い手が負担したガス（ネイティブトークン建て）。x402 exact（EIP-3009）は facilitator 負担で
                                   "0"。upto の初回 approve はその額。不明なら null
latency_ms         number|null     402 を受けてから 200 を受けるまで（ProcessPayment と再送を含む。モデルの思考時間は含めない）
http_status        number|null     最終応答の HTTP ステータス（probe は 402）
delivered          boolean         2xx で中身を受け取れたか（probe は常に false）
processPaymentId   string|null     AgentCore の ProcessPayment が返した ID
tx_hash            string|null     settle の tx ハッシュ（売り手の PAYMENT-RESPONSE / X-PAYMENT-RESPONSE / Payment-Receipt）
```

書式の外に、取り違え防止の付帯列を 2 つ付ける（比較表では使わない）:

```
source             string          元のログファイル
path               string          agentcore（本物の ProcessPayment）/ local-fake（AgentCore を呼ばない自己確認）/
                                   probe-only（402 を見ただけ）
```

## 比較で使う指標（売り手ごと）

```
実費      = settled_amount の中央値（delivered=true の行）
上乗せ    = 実費 − price の中央値（upto で上限より安く済めば負になる）
失敗率    = delivered=false の行数 / 支払い試行の行数（probe-only の行は数えない）
遅延      = latency_ms の中央値（delivered=true の行）
```

## 変換

```bash
npm run ac4:probe          # 対象 5 社 + AC-2 の売り手の 402 を取る（署名しない）→ artifacts/ac4/probe/
npm run ac4:normalize      # AC-2・AC-3・probe を変換 → artifacts/ac4/normalized.{jsonl,csv}, comparison.md
```

入力として読むもの（あるものだけ）:

```
artifacts/ac2/runs.jsonl              AC-2（scripts/ac2/run.py）
artifacts/ac3/live.json               AC-3a live（scripts/ac3/run.ts --mode=live）
artifacts/ac3/ac3b-mainnet.json       AC-3b（scripts/ac3/ac3b_mainnet.py --allow-mainnet のときだけ支払い行が出る）
artifacts/ac4/probe/probe.json        --probe-only
```

## 対象の売り手（2026-10-20 の 402。支払っていない）

```
売り手      ホスト / エンドポイント                                 方法   402 の内容
----------  ------------------------------------------------------  -----  -----------------------------------------------
OneSource   api.onesource.io /api/chain/block-number                GET    x402 v2 exact + batch-settlement, eip155:8453, $0.001
                                                                           + MPP tempo/charge ×2, tempo/session ×1（chainId 4217）
2s          2s.io /api/medical/icd10                                GET    x402 v2 exact, eip155:8453 + solana, $0.0025
2s          2s.io /api/ai/chat                                      POST   x402 v2 exact + upto, eip155:8453, $0.0025（upto は上限）
Otto AI     x402.ottoai.services /dns-lookup                        GET    x402 v2 exact, eip155:8453 + solana, $0.001
GoCreative  api.gocreativeai.com /v1/scrape/ebay/{arg}                 GET    2026-10-20 は 502（API サーバ停止中）。x402scan の保存値（2026-09-16）は
                                                                           x402 v2 exact, eip155:8453, $0.05, payTo 0xbaf55b24…53cc（+ Solana）
BlockRun    blockrun.ai /api/v1/chat/completions                    POST   x402 v2 exact のみ, eip155:8453, $0.002（リクエストごとに見積もり）
```

- 対象リストは `config/probe-targets.json`。GoCreative は API が復旧すれば同じコマンドで 402 が取れる（今は 502 の行が残る）。

### GoCreative を探した場所（2026-10-20）

```
場所                                                       結果
---------------------------------------------------------  ------------------------------------------------------------------
x402 Bazaar（discovery/resources、26,005 件のダンプ）       0 件（"creative" を含む 194 件は無関係）
x402 Bazaar の検索パラメータ（query/search/q）              無視されて全件が返る。402index は 71 件を Bazaar 由来としている
x402scan トップ・/search・/api/search・/resources           一致なし / 404
x402scan の REST（/api/x402/*）                            有料（402）のため使っていない
x402scan のサイト検索（tRPC origins.search / resources.search, "gocreative"）
                                                           発見: api / omnicall / gateway / predict.gocreativeai.com、668 リソース
402index.io（/api/v1/services?q=gocreative）                発見: gocreativeai.com の 794 件、すべて down（2026-09-19 以降失敗続き）
awesome-x402（holistis, xpaysh）                            発見: "GoCreative AI (https://api.gocreativeai.com) … USDC on Base via x402"
MCP Registry                                                発見: io.github.ColinHughes2121/gocreative-agent-api ほか com.gocreativeai.* 6 件
x402.org/ecosystem                                          404
Web 検索 "GoCreative x402"                                  glama / pulsemcp / 402index のページ
Wayback Machine                                             429（未確認）
```

同一の売り手と判断した根拠: 全ホストの payTo が同じ 2 アドレス、`com.gocreativeai.*` の MCP 名前空間（ドメイン所有が必要）、
PyPI の `gocreative-wedge-mcp` の既定 URL が api.gocreativeai.com。`gocreative.ai` は無関係のサイト。
gocreativeai.com 本体は不動産エージェント向けの AI マーケティングで、x402 API は同じブランドの別事業。
- すべて Base mainnet（または Solana mainnet / Tempo）。mainnet の実払いは AC-3b と同じ条件（本人の可・`--allow-mainnet`・
  payTo allowlist・セッション $0.20・総額 $1）でのみ行う。それまでは probe-only の行だけが出る。
- **AA 列は空欄で出力する。** AA 側のデータ取得はこのリポジトリの範囲外。

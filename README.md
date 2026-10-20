# AWS AgentCore Payments 買い手ハーネス（testnet）

「モデルに見せるツールは discover と pay の2つだけ」という構成が実機で成立するかを
確かめるための最小ハーネス。案1（Hermes mpp-agent × mpp.dev）の姉妹実装で、
同じ三層ガードレール（鍵保管／上限／人間判断）を AWS Bedrock AgentCore payments 上に置く。

**testnet 専用。** mainnet を検出したらセッションごと停止する。

## 最初に読むもの — 何が実測で、何が未達か

| | 状態 |
|---|---|
| 402 → 署名 → 再送 → 200 の一周（x402 v1 / v2 / MPP / upto） | **実測。ただし相手はローカル模擬売り手** |
| 公開 testnet エンドポイント（x402.org）への一周 | **未実施**（egress は開いた。AgentCore の資格情報待ち。`docs/AC2-results.md`） |
| AgentCore `ProcessPayment` の実行 | **未実行**（コントロールプレーンの資格情報が無い） |
| AgentCore API 形状・対応チェーン・上限の仕様 | **一次確認済み**（`docs/T1-agentcore-findings.md`） |
| 上限超過で決済に進まないこと | **実測**（`artifacts/limit-exceeded`）。per_call と session を `rule` で区別（`artifacts/per-call-only`） |
| 承認前に決済に進まないこと | **実測**（`artifacts/not-approved`, `artifacts/cli-approval-denied`） |
| 承認に金額の天井が効くこと | **実測**（`artifacts/grant-scope-exceeded`） |
| 402 が返り続けても再署名しないこと | **実測**（`artifacts/merchant-rejects`） |
| 鍵素材がログに出ないこと | **実測**（`npm run check:secrets` + 偽の鍵を流す `npm run check:redaction`） |
| 売り手側の署名検証が本物であること | **実測**（`npm run check:facilitator`） |
| GA API 形状（enum・payload） | **SDK 3.1117.0 で実測**（`npm run check:ga`）。docs との食い違いは `docs/T1-agentcore-findings.md` §3 |

採取ログの receipt には `proofSource`（agentcore / local-signer）と
`merchant`（live / mock-local）が必ず入る。実払いと取り違えられないようにしてある。

## AC-1〜AC-4（2026-10）

| | 何を測るか | 結果 | 実行 |
|---|---|---|---|
| AC-1 | ProcessPayment の冪等性と、止める条件（D1〜D8） | [`docs/AC1-results.md`](docs/AC1-results.md) | `npm run ac1`、`python scripts/ac1/d3_client_token.py` |
| AC-2 | Coinbase 経路で x402.org/protected に実払いの一周 | [`docs/AC2-results.md`](docs/AC2-results.md) | `python scripts/ac2/run.py` |
| AC-3 | upto で予算が上限額と実額のどちらで減るか | [`docs/AC3-results.md`](docs/AC3-results.md) | `npm run ac3 -- --mode=...` |
| AC-4 | AA と同じ売り手を同じ項目名で並べる書式 | [`docs/AC4-schema.md`](docs/AC4-schema.md) | `npm run ac4:probe`、`npm run ac4:normalize` |

AgentCore の資格情報が要る項目は、表に「未実施（理由）」と書いてある。資格情報が揃ったら上のコマンドを流して
`npx tsx scripts/report.ts` で表を作り直す（値は artifacts/ からだけ取る）。

この版で足したガード:
- **支払い先 allowlist**（`config/payto-allowlist.json`）。payTo × network が一致しなければ署名に進まない（TS ハーネスと Strands 例の両方）
- **upto の予約**。上限額で押さえ、settle の実額で確定して差額を解放する（exact は従来どおり）
- **`--guards=agentcore-only`**。自前の上限を判定だけ残して外す測定用モード（既定は両方有効）
- **`--probe-only`**。402 を取って記録するだけ。署名も再送もしない
- **`npm run check:keys`**。artifacts/ と docs/ の全テキストを見て、環境にある秘密 env の値そのものが出ていないことも確かめる

## 動かす

```bash
npm install

# ローカル模擬売り手（別ターミナル）
npm run mock:merchant

# 11シナリオを通しで走らせて artifacts/INDEX.json を作る
APPROVER="you@example.com" npm run run:all

# 受け入れ条件の機械検査（まとめて）
npm run check
#   typecheck        型
#   check:tools      モデルに見えるツールが2本だけか／3本目を拒否するか
#   check:ga         SDK の enum を読み直して GA 差分を検出（未確定点も出力）
#   check:redaction  偽の鍵素材を流して、伏せられること／tx参照は残ることを確認
#   check:facilitator 模擬売り手が nonce 再利用・署名改竄を実際に弾くか（要: mock:merchant 起動中）
#   check:guards     payTo allowlist / upto の予約と確定 / agentcore-only / x402 v2 の読み取り
#   check:secrets    全ログに鍵素材が出ていないか
#   check:keys       artifacts/ と docs/ の全テキストに鍵素材・秘密 env の値が出ていないか（偽の秘密で自己確認つき）

# Python 側（要: pip install "bedrock-agentcore[strands-agents]" eth-account）
npm run check:py   # Strands 経路でも allowlist に無い payTo には ProcessPayment を呼ばない
```

> この環境の env に `MAINNET_*` という名前の変数があると、ハーネスは起動時に停止する（実マネー禁止ガード）。
> 測定はそれらを外した env で行うこと（`env -u MAINNET_... npm run ...`）。

単発で回す:

```bash
# x402 経路（人間承認は対話プロンプト）
npm run harness -- --label=x402 --query=x402 --rail=x402 --approve=prompt

# MPP 経路
npm run harness -- --label=mpp --query=mpp --rail=mpp --approve=prompt

# 実エンドポイント + AgentCore（要: 資格情報とコネクタ。docs/T4-T5-blocked.md）
AGENTCORE_PAYMENT_MANAGER_ARN=... AGENTCORE_PAYMENT_INSTRUMENT_ID=... \
  npm run harness -- --backend=agentcore --allow-live --endpoint=<url> --rail=x402
```

## 主なオプション

| | |
|---|---|
| `--query=<s>` | discover に渡すクエリ |
| `--rail=x402\|mpp` | 支払うレール |
| `--endpoint=<url>` | discover を経ずに直接指定 |
| `--backend=local-signer\|agentcore` | 証明を誰が作るか（既定 `local-signer`） |
| `--planner=scripted\|anthropic` | ツールを呼ぶのが決定論スクリプトか実 LLM か（既定 `scripted`） |
| `--approve=prompt\|yes\|no\|no-after-first` | 承認の取り方（既定 `prompt` = 対話）。`no-after-first` は1回目だけ承認（承認範囲の検証用） |
| `--endpoints=a,b` | 複数エンドポイントを順に pay する |
| `--allow-live` | レジストリの live エンドポイントを叩く（既定は mock のみ） |

環境変数: `PER_CALL_MAX_USD`（既定 0.05）、`SESSION_MAX_USD`（既定 0.20）、
`AGENTCORE_CHAIN`（既定 BASE_SEPOLIA、testnet 以外は起動時エラー）、
`AUTO_APPROVE`（既定 false）、`APPROVER`、`AWS_REGION`、
`MAX_PROCESS_PAYMENT_ATTEMPTS`（既定 1）、`MAX_RESEND_ATTEMPTS`（既定 1）、
`AGENTCORE_X402_PAYLOAD_MODE`（`quickstart` | `requirements`、既定 `quickstart`）。

## 実払いまでの最小手順（Privy）

**独自ハーネスは実払いの必須ではない。** 決済の芯（402 検出・署名・再送・上限）は
AgentCore と統合プラグインが持つので、ここでやるのは provision と入金だけ。
手順の全文と当日の注意は [`docs/T4-T5-blocked.md`](docs/T4-T5-blocked.md)。

```bash
# 1) provision（Privy / MANUAL）
npm run provision -- --mode=manual --vendor=privy --dry-run
npm run provision -- --mode=manual --vendor=privy

# 2) 返ってくる redirectUrl をブラウザで開き、署名許可と testnet USDC の入金
#    （入金先アドレスは instrument を作るまで決まらないので、USDC は最後の工程）

# 3) 払う
pip install "bedrock-agentcore[strands-agents]"
python examples/pay_with_strands.py <有料エンドポイントのURL>
```

Coinbase を使う場合は `--vendor=coinbase`、OAuth 同意で鍵の発行を省くなら
`npm run provision`（Quick Create、Coinbase 専用）。
**`--mode=manual` にしても vendor が Coinbase なら CDP アカウントは要る。**
Coinbase 依存から外れるのは vendor=privy だけ。

> **プラグイン構成に testnet 強制は無い。** `network_preferences_config` は
> 並べ替えのヒントで、一致しなければ先頭の accept にフォールバックする（実測）。
> しかも slug と CAIP-2 の両方を入れないと一致しない
> （`["eip155:84532"]` だけだと Base mainnet が選ばれる）。
> 売り手が mainnet しか出さなければ防げない。詳細と実測表は
> [`docs/T4-T5-blocked.md`](docs/T4-T5-blocked.md)。

出力の ARN / ID を env に入れて `--backend=agentcore --allow-live` で回す。
必要なもの一覧とライブ1回目で決着させる項目は `docs/T4-T5-blocked.md`。

## 構成

```
src/agent/tools.ts      モデルに見せる2ツール（ここに3つ目を足さない）
src/agent/planner.ts    LLM（Anthropic）か決定論スクリプト。ツール発行の経路は同一
src/tools/discover.ts   ディレクトリ + 402プローブ → 候補（price, rail）
src/tools/pay.ts        402 → 上限 → 承認 → 署名 → 再送 → receipt
src/guard/limits.ts     層2: per_call / session 上限（atomic 整数で判定。どの規則で落ちたかを返す）
src/guard/approval.ts   層3: 承認点2つ。自動承認は既定オフ
src/guard/approvalLedger.ts  承認の有効範囲（オリジン + 金額の天井、セッション内のみ）
src/guard/demandLedger.ts    二重支払いと再送回数の抑止（clientToken を demand ごとに固定）
src/guard/redact.ts     層1: 鍵素材の出口側フィルタ
src/guard/network.ts    mainnet 検出で停止（allowlist 方式）
src/guard/payToAllowlist.ts  支払い先（payTo × network）の allowlist。config/payto-allowlist.json
src/tools/probe.ts      --probe-only（402 を記録するだけ。署名しない）
src/rails/upto.ts       x402 upto（Permit2 witness）の署名データ
src/backends/agentcore.ts   実 AgentCore（ProcessPayment / CreatePaymentSession）
src/backends/paymentStatus.ts  status の分類。SDK と docs の食い違いをここで吸収する
src/rails/caip2.ts      network 表記の変換（slug ↔ CAIP-2）。未知は停止側に倒す
src/backends/localSigner.ts 代替。EIP-712/EIP-3009 を実際に署名する一時鍵
src/rails/x402.ts       x402 v1 + HTTP transport
src/rails/mpp.ts        MPP draft-httpauth-payment-00 + evm/charge
mock/server.ts          模擬売り手 + facilitator（署名検証は本物、決済はしない）
scripts/provision-agentcore.mts  AgentCore のプロビジョニング（--dry-run / --mode / --vendor）
examples/pay_with_strands.py     Strands プラグインで払う最小結線（実払いはこちらが本線）
infra/iam/              サービスロールの信頼ポリシーと権限の雛形
docs/                   T1 の一次確認、未達の理由、図、6軸比較、記事差し替えメモ
scripts/ac1/            AC-1（run.ts: ProcessPayment 直叩き D1〜D8 / d3_client_token.py: D3）
scripts/ac2/            AC-2（run.py: 10 回計測とオンチェーン照合 / cloudwatch.py / check_payto_guard.py）
scripts/ac3/            AC-3（run.ts: upto の予算 / blockrun_mainnet.py: AC-3b、--allow-mainnet 必須）
scripts/ac4/normalize.ts AC-4 の書式へ変換と比較表（AA 列は空欄）
scripts/py/             Python 共用（LocalPlane: AgentCore を呼ばない結線確認 / 台本モデル / scrub）
scripts/report.ts       artifacts から docs/AC1〜AC3-results.md を作り直す
examples/payto_guard.py Strands 経路の payTo allowlist（402 を削ってから署名に渡す）
artifacts/              採取ログ（events.jsonl / summary.json / INDEX.json）
```

## やらないこと

実マネー（mainnet・実 USDC）。2経路を超える網羅。与信・後払い（問題D）。
モデルに discover / pay 以外のツールを露出すること。本番向けの鍵管理。

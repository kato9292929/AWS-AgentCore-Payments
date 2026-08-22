# AWS AgentCore Payments 買い手ハーネス（testnet）

「モデルに見せるツールは discover と pay の2つだけ」という構成が実機で成立するかを
確かめるための最小ハーネス。案1（Hermes mpp-agent × mpp.dev）の姉妹実装で、
同じ三層ガードレール（鍵保管／上限／人間判断）を AWS Bedrock AgentCore payments 上に置く。

**testnet 専用。** mainnet を検出したらセッションごと停止する。

## 最初に読むもの — 何が実測で、何が未達か

| | 状態 |
|---|---|
| 402 → 署名 → 再送 → 200 の一周（x402 / MPP 両方） | **実測。ただし相手はローカル模擬売り手** |
| 公開 testnet エンドポイント（mpp.dev / x402.org）への一周 | **未実施**（egress 403。`docs/T4-T5-blocked.md`） |
| AgentCore `ProcessPayment` の実行 | **未実行**（コントロールプレーンの資格情報が無い） |
| AgentCore API 形状・対応チェーン・上限の仕様 | **一次確認済み**（`docs/T1-agentcore-findings.md`） |
| 上限超過で決済に進まないこと | **実測**（`artifacts/limit-exceeded`） |
| 承認前に決済に進まないこと | **実測**（`artifacts/not-approved`, `artifacts/cli-approval-denied`） |
| 鍵素材がログに出ないこと | **実測**（`npm run check:secrets`） |

採取ログの receipt には `proofSource`（agentcore / local-signer）と
`merchant`（live / mock-local）が必ず入る。実払いと取り違えられないようにしてある。

## 動かす

```bash
npm install

# ローカル模擬売り手（別ターミナル）
npm run mock:merchant

# 8シナリオを通しで走らせて artifacts/INDEX.json を作る
APPROVER="you@example.com" npm run run:all

# 受け入れ条件の機械検査
npm run check:tools     # モデルに見えるツールが2本だけか
npm run check:secrets   # 全ログに鍵素材が出ていないか
npm run typecheck
```

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
| `--approve=prompt\|yes\|no` | 承認の取り方（既定 `prompt` = 対話） |
| `--allow-live` | レジストリの live エンドポイントを叩く（既定は mock のみ） |

環境変数: `PER_CALL_MAX_USD`（既定 0.05）、`SESSION_MAX_USD`（既定 0.20）、
`AGENTCORE_CHAIN`（既定 BASE_SEPOLIA、testnet 以外は起動時エラー）、
`AUTO_APPROVE`（既定 false）、`APPROVER`、`AWS_REGION`。

## 構成

```
src/agent/tools.ts      モデルに見せる2ツール（ここに3つ目を足さない）
src/agent/planner.ts    LLM（Anthropic）か決定論スクリプト。ツール発行の経路は同一
src/tools/discover.ts   ディレクトリ + 402プローブ → 候補（price, rail）
src/tools/pay.ts        402 → 上限 → 承認 → 署名 → 再送 → receipt
src/guard/limits.ts     層2: per_call / session 上限（atomic 整数で判定）
src/guard/approval.ts   層3: 承認点2つ。自動承認は既定オフ
src/guard/redact.ts     層1: 鍵素材の出口側フィルタ
src/guard/network.ts    mainnet 検出で停止（allowlist 方式）
src/backends/agentcore.ts   実 AgentCore（ProcessPayment / CreatePaymentSession）
src/backends/localSigner.ts 代替。EIP-712/EIP-3009 を実際に署名する一時鍵
src/rails/x402.ts       x402 v1 + HTTP transport
src/rails/mpp.ts        MPP draft-httpauth-payment-00 + evm/charge
mock/server.ts          模擬売り手 + facilitator（署名検証は本物、決済はしない）
docs/                   T1 の一次確認、未達の理由、図、6軸比較、記事差し替えメモ
artifacts/              採取ログ（events.jsonl / summary.json / INDEX.json）
```

## やらないこと

実マネー（mainnet・実 USDC）。2経路を超える網羅。与信・後払い（問題D）。
モデルに discover / pay 以外のツールを露出すること。本番向けの鍵管理。

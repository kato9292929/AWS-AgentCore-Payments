# T4 / T5: 公開テストエンドポイントへの実払いが本セッションで完了できない理由

結論から書く。**x402 経路・MPP 経路とも、HTTP の一周（402 → 署名 → 再送 → 200 →
receipt）はコードとして動いており、ログも採れている。ただし相手はローカルの模擬売り手であって、
mpp.dev でも Exa でもない。** AgentCore の `ProcessPayment` も実行できていない。

「一周できた」と書いてよいのは模擬売り手に対してだけで、
**公開 testnet エンドポイントに対しては一周していない。**

## 何が塞がれているか（実測）

### 1. 売り手側エンドポイントへの egress

`artifacts/live-attempt/events.jsonl` より、`--allow-live` で実際に叩いた結果:

```json
{ "type": "http.response", "phase": "x402.bare-request", "url": "https://x402.org/protected",
  "status": 403, "headers": { "x-deny-reason": "host_not_allowed" },
  "body": "Host not in allowlist: x402.org. Add this host to your network egress settings t..." }

{ "type": "http.response", "phase": "mpp.bare-request", "url": "https://mpp.dev/",
  "status": 403, "headers": { "x-deny-reason": "host_not_allowed" },
  "body": "Host not in allowlist: mpp.dev. Add this host to your network egress settings t..." }
```

同じ理由で `docs.aws.amazon.com` `aws.amazon.com` `note.com` も 403。
`github.com` `raw.githubusercontent.com` `registry.npmjs.org` は許可されている
（プロトコル仕様と SDK はここから一次確認した）。

### 2. AgentCore コントロールプレーンの資格情報

`artifacts/aws-access-probe.json` より:

```
data plane    (bedrock-agentcore.us-east-1.amazonaws.com)         → AccessDeniedException / "Payment manager not found"
control plane (bedrock-agentcore-control.us-east-1.amazonaws.com) → UnrecognizedClientException / "The security token included in the request is invalid."
```

データプレーンは認証が通っている（＝到達している）が、コントロールプレーンが叩けないので
`CreatePaymentManager` → `CreatePaymentConnector` → `CreatePaymentInstrument` の
provisioning ができない。paymentManagerArn が無ければ `ProcessPayment` は呼べない。

`artifacts/agentcore-attempt/events.jsonl` は、実際に `--backend=agentcore` で走らせて
`CreatePaymentSession` が `AccessDeniedException: Payment manager not found` で
止まったところまでの記録。**この経路のコードは書いてあり、止まった場所も特定できている。**

## 代わりに何をしたか

`mock/server.ts` に、x402 と MPP の仕様どおりに 402 を返す売り手と、
署名検証を行う facilitator 相当を置いた。ローカル（127.0.0.1）なので egress を通らない。

**本物である部分**
- HTTP の形: ステータス・ヘッダ・ボディが x402 v1 / MPP core draft のとおり
  （`X-PAYMENT` / `X-PAYMENT-RESPONSE`、`WWW-Authenticate: Payment` / `Authorization: Payment` / `Payment-Receipt`）
- 暗号: EIP-712 / EIP-3009 の署名を実際に生成し、売り手が viem で**実際に検証している**
  （署名を1バイト変えれば 402 に戻る）
- MPP のチャレンジ束縛: HMAC-SHA256 binding と
  `nonce = keccak256(abi.encodePacked(challenge.id, challenge.realm))` を実装・検証

**本物でない部分**
- オンチェーン決済をしていない。receipt の `reference` は決済シミュレーションの識別子で、
  base-sepolia のエクスプローラには存在しない
- 署名しているのが AgentCore ではなくプロセス内の一時鍵（`proofSource: "local-signer"`）
- 相手が実在の売り手ではない（`merchant: "mock-local"`）

採取ログの receipt には `proofSource` と `merchant` が必ず入るので、
**後からこのログを見た人が実払いと取り違えることはない。**

## 埋めるために必要なもの

| # | 必要なもの | 用途 |
|---|---|---|
| 1 | 売り手ホストへの egress 許可（`x402.org` / `mpp.dev` / Bazaar 経由の各エンドポイント） | T4/T5 の相手。**使うものだけ**足す。ワイルドカードで広く開けない |
| 2 | `bedrock-agentcore.<region>.amazonaws.com` と `bedrock-agentcore-control.<region>.amazonaws.com` への egress 許可 | データ／コントロール両プレーン |
| 3 | `sts.amazonaws.com` / `secretsmanager.<region>.amazonaws.com` への egress 許可 | 資格情報の検証と credential provider の裏側 |
| 4 | `docs.aws.amazon.com` への egress 許可 | 料金・リージョン・status enum の一次確認（下の食い違いを決着させる） |
| 5 | AgentCore コントロールプレーンを叩ける AWS 資格情報 | manager / connector / credential provider の作成 |
| 6 | IAM サービスロール（信頼するのは `bedrock-agentcore.amazonaws.com`） | `CreatePaymentManager` の `roleArn` |
| 7 | Coinbase の OAuth 同意（**鍵の発行は不要**） | Quick Create。`provisionMode=QUICK_CREATE` で connector を作ると `authorizationUrl` が返るので、人間がブラウザで同意する。サービス側が credential provider を作る。<br>Stripe Privy を使う場合のみ鍵の手持ち込みが必要（`--mode=manual`） |
| 8 | base-sepolia の testnet USDC | 実際の支払い原資。**事前に用意するものではない**（下記） |
| 9 | Base Sepolia RPC（例 `sepolia.base.org`）への egress 許可 | 残高・決済の確認（任意） |

> 実行環境ごとに allowlist が違う。実測:
> - 2026-08-22 / 2026-08-25 の環境: `bedrock-agentcore*` には届く（認証エラーまで進む）が
>   `x402.org` / `mpp.dev` / `docs.aws.amazon.com` / `note.com` は 403。
> **AWS 結線と testnet 到達の両方が同時に開いた環境**でないと一周できない。

### 入金は「最後」であって「前提」ではない

testnet USDC の入金先アドレスは**事前に決められない**。instrument を作って初めて
Coinbase ホストの WalletHub への `redirectUrl` が返り、そこで
「エージェントへの署名許可」と「入金」を両方行う。つまり順番は
egress → AWS 資格情報/IAM ロール → OAuth 同意 → instrument 作成 → **入金**。

出典（Python SDK `bedrock-agentcore` 1.22.0 の `payments/README.md`）:
> Once created, the instrument must be funded and permission granted for signing
> before the agent can use it. These are end-user actions...
> **Coinbase**: You'll receive a `redirectUrl` in the response pointing to the
> Coinbase-hosted WalletHub.

なお `authorizationUrl` と `redirectUrl` は**人間がブラウザで開く**もので、
ハーネスやスクリプトは叩かない。したがって egress の allowlist に
Coinbase 側のホストを足す必要はない。

### instrument の network と売り手のチェーンを合わせる

instrument の `network` は `ETHEREUM` か `SOLANA` の二択（`CryptoWalletNetwork` enum）。
本ハーネスは `ETHEREUM` を使うので、**売り手が EVM 系（base-sepolia 等）を提示するもの**
に揃える必要がある。同 README の Best Practices:
> Ensure your payment instrument's network matches at least one accept in the x402 payload

## 揃ったら走らせる手順（ハーネス無改修）

```bash
# 0) 前提: 上の 1〜8 が揃っている。リージョンは egress / IAM / ARN で揃える
export AWS_REGION=us-west-2
export AGENTCORE_ROLE_ARN=arn:aws:iam::<acct>:role/<agentcore-payments-role>
export PAYMENT_USER_EMAIL=you@example.com
#   Coinbase Quick Create なら CDP の鍵は要らない（OAuth 同意で済む）

# 1) プロビジョニング（manager → connector(QUICK_CREATE) → instrument）
#    人手が 2 回入る:
#      (1/2) connector の authorizationUrl を開いて OAuth 同意
#      (2/2) instrument の redirectUrl を開いて署名許可＋testnet USDC 入金
npm run provision
#    先に手順だけ見るなら: npm run provision -- --dry-run
#    鍵を手で持ち込む / Privy を使うなら: npm run provision -- --mode=manual

# 2) 出力（artifacts/provision-output.json）の値を env に入れてライブ一周
export AGENTCORE_PAYMENT_MANAGER_ARN=arn:aws:bedrock-agentcore:us-west-2:<acct>:payment-manager/<id>
export AGENTCORE_PAYMENT_INSTRUMENT_ID=<instrument-id>
export AGENTCORE_PAYMENT_CONNECTOR_ID=<connector-id>
npm run harness -- --label=x402-live --backend=agentcore --allow-live \
  --endpoint=<Bazaar か公開売り手の URL> --rail=x402 --approve=prompt

# 3) 回帰確認（mock は常に緑を維持）
npm run run:all && npm run check
```

`npm run provision` はクレデンシャルを標準出力にも `artifacts/provision-output.json` にも書かない。
出るのは ARN / ID / status だけで、`npm run check:secrets` の走査対象にも入っている。

## ライブ 1 回目で決着させること（[要ライブ確認]）

推測で埋めず、実際に返ってきた値で更新する。

| # | 確認すること | なぜ決着が要るか | 更新先 |
|---|---|---|---|
| 1 | `ProcessPayment` が返す status の実値 | SDK は `PROOF_GENERATED` 単一、GA docs は `PENDING/SUCCESS/FAILED`。**一次情報どうしが食い違っている** | `docs/T1-agentcore-findings.md` §3、`src/backends/paymentStatus.ts` |
| 2 | `SUCCESS`（または `PROOF_GENERATED`）の時点でオンチェーン確定しているか | 買い手再送モデルを維持してよいかが決まる | 同上。確定するまで receipt の `settlementConfirmedBy` は売り手の受領ヘッダ基準のまま |
| 3 | MPP の `paymentType` enum 値 | SDK は `MPP`、GA quick start は `CRYPTO_X402` のみ記載 | `src/backends/agentcore.ts` |
| 4 | ProcessPayment payload の `network` 表記（CAIP-2 か slug か） | `AGENTCORE_X402_PAYLOAD_MODE` の既定をどちらにするか。ValidationException が出たら `requirements` に倒す | `src/backends/agentcore.ts` の `buildX402Payload()` |
| 5 | instrument / session の status 実値 | SDK と docs で表記が違う（`INITIATED` vs `PENDING` など） | `scripts/provision-agentcore.mts` |
| 6 | 実際に到達できた売り手ホスト | | `config/endpoints.testnet.json` の該当項目を `reachability: "ok"` に |
| 7 | receipt に `proofSource: "agentcore"` / `merchant: "live"` が入るか | mock-local と取り違えないための最終確認 | 採取ログ |

`config/endpoints.testnet.json` の live 項目は到達確認まで `reachability: "unverified"` を維持。
到達確認をしていないものを `ok` に書き換えないこと。

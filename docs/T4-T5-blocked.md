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
| 1 | `x402.org` `mpp.dev`（および実際に使う売り手ホスト）への egress 許可 | T4/T5 の相手 |
| 2 | `docs.aws.amazon.com` への egress 許可 | T1 の料金・リージョンの一次確認 |
| 3 | AgentCore コントロールプレーンを叩ける AWS 資格情報 | payment manager / connector / instrument の作成 |
| 4 | Coinbase CDP または Stripe Privy のクレデンシャル | `CreatePaymentCredentialProvider`（AWS だけでは足りない） |
| 5 | base-sepolia の testnet USDC | 実際の支払い原資 |

1〜5 が揃えば、コードは以下の 1 コマンドで公開エンドポイントに向く。
ハーネス側の変更は要らない。

```bash
AGENTCORE_PAYMENT_MANAGER_ARN=arn:aws:bedrock-agentcore:us-east-1:<acct>:payment-manager/<id> \
AGENTCORE_PAYMENT_INSTRUMENT_ID=<instrument-id> \
npm run harness -- --label=x402-live --backend=agentcore --allow-live \
  --endpoint=<公開エンドポイント> --rail=x402 --approve=prompt
```

`config/endpoints.testnet.json` の live 項目は `reachability: "unverified"` のままにしてある。
到達確認をしていないものを `ok` に書き換えないこと。

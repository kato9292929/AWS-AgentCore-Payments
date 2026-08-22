# T1: AWS Bedrock AgentCore payments の一次確認

取得日: 2026-08-22 / 確認者: hello@x402jp.com

## 0. 何を一次情報として使ったか（重要）

本セッションの egress ポリシーは `docs.aws.amazon.com` と `aws.amazon.com` を
**403 host_not_allowed** で塞ぐ。したがって公式ドキュメントページの精読はできていない。

代わりに、**同じ AWS API モデルから生成される SDK 型定義**を一次情報として使った。

```
node_modules/@aws-sdk/client-bedrock-agentcore@3.1116.0/dist-types/models/models_0.d.ts
node_modules/@aws-sdk/client-bedrock-agentcore@3.1116.0/dist-types/models/models_1.d.ts
node_modules/@aws-sdk/client-bedrock-agentcore@3.1116.0/dist-types/models/enums.d.ts
node_modules/@aws-sdk/client-bedrock-agentcore-control@3.1116.0/dist-types/models/*
```

これは AWS が公開している生成物であり、operation 名・パラメータ名・enum 値・
制約（範囲）まで docstring ごと含む。「x402/MPP 両対応か」「testnet 可か」の判断は
この enum と shape から取れる。ただし**料金・リージョン提供状況・SLA はここには無い**。
それらは未確認のままにしてある（推測で埋めていない）。

補助的に、Web 検索の結果として次を参照した（本文は取得できていない、リンクのみ）:
- AWS What's New「AgentCore payments is now generally available」(2026-08)
- AWS ML Blog「Amazon Bedrock AgentCore payments is now generally available」
- Coinbase「Introducing Amazon Bedrock AgentCore Payments, Powered by x402 and Coinbase」

## 1. 「x402 と MPP の両対応」の根拠

`enums.d.ts`:

```ts
export declare const PaymentType: {
    readonly CRYPTO_X402: "CRYPTO_X402";
    readonly MPP: "MPP";
};
```

`models_1.d.ts` の `PaymentInput` / `PaymentOutput` は両方の union member を持つ。

```ts
export type PaymentInput = PaymentInput.CryptoX402Member | PaymentInput.MppMember | PaymentInput.$UnknownMember;
export type PaymentOutput = PaymentOutput.CryptoX402Member | PaymentOutput.MppMember | PaymentOutput.$UnknownMember;
```

→ **両対応は確認できた。** 1 回の `ProcessPayment` で扱えるのは片方（union）。

## 2. 「testnet 可」の根拠

`enums.d.ts`:

```ts
export declare const BlockchainChainId: {
    readonly BASE: "BASE";
    readonly BASE_SEPOLIA: "BASE_SEPOLIA";
    readonly ETHEREUM: "ETHEREUM";
    readonly SOLANA: "SOLANA";
    readonly SOLANA_DEVNET: "SOLANA_DEVNET";
};
export declare const InstrumentBalanceToken: { readonly USDC: "USDC"; };
export declare const Currency: { readonly USD: "USD"; };
```

→ **testnet は BASE_SEPOLIA と SOLANA_DEVNET の 2 つ。** 本ハーネスは
`BASE_SEPOLIA` を既定にし、`BASE` / `ETHEREUM` / `SOLANA` を検出したら停止する
（`src/guard/network.ts`）。

`Currency` が `USD` のみである点は上限設計に効く。**セッション上限は USD 建てでしか
指定できない**（トークン建てではない）。

## 3. 支払い上限は API 側にもある

```ts
export interface SessionLimits { maxSpendAmount: Amount | undefined; }
export interface Amount { value: string | undefined; currency: Currency | undefined; }

export interface CreatePaymentSessionRequest {
    paymentManagerArn: string | undefined;
    limits?: SessionLimits | undefined;
    expiryTimeInMinutes: number | undefined;  // "Must be between 15 and 480 minutes."
    userId?: string; agentName?: string; clientToken?: string;
}
```

→ AgentCore が持つのは**セッション累計上限（maxSpendAmount）だけ**。
指示書 5節の `per_call_max`（1回あたり上限）に対応する API パラメータは
**存在しない**。1回あたり上限はハーネス側で実装する必要がある。
本実装では両方をハーネス側（`src/guard/limits.ts`）に持ち、
セッション累計上限は AgentCore にも同じ値を渡して二重にかけている。

`AvailableLimits { availableSpendAmount, updatedAt }` があるので、
残額は `GetPaymentSession` で引ける。

## 4. ProcessPayment は「証明」までを返す（決済はしない）

```ts
export declare const PaymentStatus: { readonly PROOF_GENERATED: "PROOF_GENERATED"; };
```

`PaymentStatus` の値は `PROOF_GENERATED` **1 つだけ**。`SETTLED` も `FAILED` も無い。

出力側:

```ts
export interface CryptoX402PaymentOutput { version: string; payload: __DocumentType; }
export interface MppPaymentOutput {
  version: string;            // "1" or "2"
  selectedPaymentId: string;  // 支払ったチャレンジの id
  paymentCredential: string;  // 'Ready-to-send value for the Authorization header,
                              //  in the form "Payment <base64url-token>"'
}
```

→ **AgentCore は署名済みの支払い証明を返すところまでを担う。**
402 の再送も、オンチェーン決済（facilitator への verify/settle）も、
それぞれ買い手ハーネスと売り手側の仕事。3節のフロー図はこの前提で正しい。

これは設計上けっこう大きい。「AgentCore を入れたら決済が終わる」ではなく、
**「鍵と署名だけを AgentCore に預け、HTTP の一周は自分で回す」**という分界になる。

## 5. 入力の形（そのまま実装に落ちる）

```ts
export interface CryptoX402PaymentInput {
  version: string;
  payload: __DocumentType;
  permit2AllowanceLimit?: string;
  // "This field is valid only for the `upto` (metered) scheme;
  //  supplying it for the `exact` scheme returns a validation error."
}

export interface MppPaymentInput {
  version: string;
  wwwAuthenticateHeaders: string[];
  // "The raw WWW-Authenticate: Payment header value from the 402 response,
  //  passed verbatim. Provide exactly one entry."
  buyerPaysGasFees?: boolean;
  // "Authorizes the service to sign a payment whose blockchain network (gas) fees
  //  are charged to your wallet... When omitted or false, you decline to pay network fees."
}
```

実装上の含意:
- MPP 側は **402 のヘッダを verbatim で渡すだけでよい**。パースは AgentCore がやる。
  （本ハーネスは上限判定のために自分でもパースするが、`ProcessPayment` には生値を渡す）
- `buyerPaysGasFees` は**既定 false で明示**する。ガス肩代わりを黙って承諾しない。
- x402 の `upto` スキーム（GA で追加）は `permit2AllowanceLimit` を伴う。
  本作業は `exact` のみ。`upto` は未検証。

## 6. ウォレットとコネクタ

```ts
export declare const PaymentInstrumentType: { readonly EMBEDDED_CRYPTO_WALLET: "EMBEDDED_CRYPTO_WALLET"; };
export declare const CryptoWalletNetwork: { readonly ETHEREUM: "ETHEREUM"; readonly SOLANA: "SOLANA"; };
export interface EmbeddedCryptoWallet {
  network: CryptoWalletNetwork;   // "Supported networks: ETHEREUM, SOLANA."
  linkedAccounts: LinkedAccount[];
  walletAddress?: string;
  redirectUrl?: string;           // end user のウォレット紐付け導線
}
// control plane:
export declare const PaymentConnectorType: { readonly COINBASE_CDP: "CoinbaseCDP"; readonly STRIPE_PRIVY: "StripePrivy"; };
export declare const PaymentConnectorProvisionMode: /* MANUAL | QUICK_CREATE */;
```

→ 買い手ウォレットは **Coinbase CDP か Stripe Privy のどちらかのコネクタ配下**に作る。
つまり AgentCore payments を使うには **AWS だけでは足りない**。
Coinbase または Stripe 側のクレデンシャルが要る（`CreatePaymentCredentialProvider`）。
`QUICK_CREATE` は「サービスが OAuth 同意を仲介して provider を用意する」モード。

**これは 7節のコスト見積りに直結する未確認事項**: AWS 実費に加えて
コネクタ提供元（Coinbase/Stripe）側の課金があるかは未確認。

## 7. この環境からどこまで届いたか（実測）

`artifacts/aws-access-probe.json`:

```json
{
  "dataPlane_ListPaymentSessions":    { "errorName": "AccessDeniedException",      "httpStatus": 403, "message": "Payment manager not found" },
  "controlPlane_ListPaymentManagers": { "errorName": "UnrecognizedClientException", "httpStatus": 403, "message": "The security token included in the request is invalid." }
}
```

読み方:
- **データプレーン**（`bedrock-agentcore.us-east-1.amazonaws.com`）は SigV4 が通り、
  サービスが「その payment manager は無い」と答えている。到達している。
- **コントロールプレーン**（`bedrock-agentcore-control...`）は資格情報が無効。
  つまり `CreatePaymentManager` / `CreatePaymentConnector` /
  `CreatePaymentCredentialProvider` を**この環境からは実行できない**。

→ **T1 の「AgentCore Payments を testnet で有効化」は本セッションでは完了できない。**
必要なのは (a) コントロールプレーンを叩ける AWS 資格情報、
(b) Coinbase CDP か Stripe Privy のクレデンシャル。

## 8. 確定した設定値（受け入れ条件の「ログに固定」）

`artifacts/*/events.jsonl` の先頭 `harness.config` に毎回入る:

```json
{
  "region": "us-east-1",
  "chain": "BASE_SEPOLIA",
  "facilitator": "https://x402.org/facilitator",
  "testnet": true,
  "per_call_max_usd": "0.050000",
  "session_max_usd": "0.200000",
  "auto_approve": false,
  "backend": "local-signer",
  "planner": "scripted"
}
```

`facilitator` は「誰が verify/settle を持つか」の記録であって、
買い手ハーネスがこの URL を叩くわけではない（4節のとおり売り手側が叩く）。

## 9. 未確認のまま残したもの

| 項目 | 状態 | 理由 |
|---|---|---|
| 料金（AgentCore payments の実行課金） | 未確認 | 料金ページに到達不可 |
| リージョン提供状況 | 未確認 | 同上。`us-east-1` は既定として置いただけ |
| testnet で facilitator に何が使われるか | 未確認 | ProcessPayment を実行できていない |
| `upto` スキームの挙動 | 未検証 | `exact` のみ実装 |
| Coinbase Bazar MCP（GA で追加の x402 エンドポイント集） | 未確認 | discover の候補源として有力だが到達不可 |
| コネクタ側（Coinbase/Stripe）の課金 | 未確認 | — |

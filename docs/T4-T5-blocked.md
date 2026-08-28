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

## 実払いまでの最小手順（Privy / MANUAL）

2026-08-26 に方針を変更。**独自ハーネスは実払いの必須ではない**ので、
決済の芯（402 検出・署名・再送・上限）は AgentCore と統合プラグインに任せる。
ここでやるのは provision と入金だけ。

Coinbase ではなく Privy を使う理由: 日本から Coinbase の利用可否が不確実なため。
Quick Create は Coinbase 専用なので使わない。**`--mode=manual` に落としても
vendor が CoinbaseCDP なら CDP アカウントは要る**（鍵を手で持つか OAuth で委ねるかの差でしかない）。
Coinbase 依存から本当に外れるのは vendor=StripePrivy だけ。

### 0. 揃えるもの

| # | もの | 備考 |
|---|---|---|
| 1 | AWS 資格情報 ＋ IAM サービスロール | 雛形は `infra/iam/`。リージョンは `us-east-1` / `us-west-2` / `eu-central-1` / `ap-southeast-2` のいずれか（東京は無い） |
| 2 | Privy の4値 | `PRIVY_APP_ID` / `PRIVY_APP_SECRET` / `PRIVY_AUTHORIZATION_ID` / `PRIVY_AUTHORIZATION_PRIVATE_KEY`。日本での登録可否は docs に記載が無く、サインアップ時に確認するしかない |
| 3 | egress 許可 | 下記。売り手ホストは使うものだけ足す |
| 4 | testnet USDC | **独立準備ではない。** 手順2で返る `redirectUrl` から入金する |

egress（同一リージョンで揃える。ワイルドカード不可）:

```
bedrock-agentcore.<region>.amazonaws.com          # 確実（provision と支払いが叩く）
bedrock-agentcore-control.<region>.amazonaws.com  # 確実（manager / connector 作成）
<実際に叩く売り手ホスト>                            # 確実
sts.amazonaws.com                                 # 条件付き（下記）
secretsmanager.<region>.amazonaws.com             # おそらく不要（下記）
```

`sts` と `secretsmanager` について（実測に基づく訂正）:

- **`sts`**: 静的アクセスキーを env に置くなら STS は呼ばれない。
  assume-role / SSO / IMDS で資格情報を解決する場合だけ必要。
- **`secretsmanager`**: `scripts/` と `src/` に SecretsManager クライアントも
  STS クライアントも存在しない（grep でヒット 0）。資格情報を保管するのは
  サービス側がロールで行うので、**あなたのマシンからの egress は要らない**はず。
  IAM 権限（`secretsmanager:CreateSecret`）とは別の話。

以前の版で両方を「必須」と書いていたのは確認していない転記だった。
足しても害は無いが、必須ではない。

### 1. env

```bash
export AWS_REGION=<region>
export AGENTCORE_ROLE_ARN=arn:aws:iam::<acct>:role/<service-role>
export PAYMENT_USER_EMAIL=you@example.com
# Privy の4値（行頭スペース＋ HISTCONTROL=ignorespace で履歴に残さない）
 export PRIVY_APP_ID=...
 export PRIVY_APP_SECRET=...
 export PRIVY_AUTHORIZATION_ID=...
 export PRIVY_AUTHORIZATION_PRIVATE_KEY=...
```

### 2. provision

```bash
npm run provision -- --mode=manual --vendor=privy --dry-run   # 入力と手順の確認
npm run provision -- --mode=manual --vendor=privy             # 本番
```

内部でやること:

```
0 CreatePaymentCredentialProvider   StripePrivy の4値を預ける
1 CreatePaymentManager              READY を待つ
2 CreatePaymentConnector            StripePrivy / MANUAL、READY を待つ
3 CreatePaymentInstrument           network=ETHEREUM。redirectUrl が返る
4 （待機）                           instrument が ACTIVE になるまで
5 GetPaymentInstrumentBalance       原資の確認
6 CreatePaymentSession              maxSpendAmount と有効期限で区切る
```

出力 `artifacts/provision-output.json` に manager ARN / connector ID / instrument ID /
session ID が入る。**資格情報は出力にもログにも出さない。**

セッション上限は `SESSION_MAX_USD`（既定 $0.20）と `SESSION_EXPIRY_MINUTES`（既定 15、API 制約 15〜480）。
期限が切れたら `CreatePaymentSession` をやり直せばよく、provision 全体の再実行は要らない。

### 3. 入金（人手・1回）— **Privy では Coinbase と手順が違う可能性が高い**

Python SDK の README（`payments/README.md`）にこう書いてある:

> - **Coinbase**: You'll receive a `redirectUrl` in the response pointing to the
>   Coinbase-hosted WalletHub. Redirect your user there to grant signing permission
>   and transfer funds.
> - **Stripe**: Developers use a provided URL template to host a frontend page where
>   end users can take the same actions.

つまり **Coinbase はホスト済みの画面が返るが、Privy は「URL テンプレートを渡すので
開発者が自分でフロントを立てろ」**と読める。`CreatePaymentInstrument` の応答に
`redirectUrl` が入るかどうかも Privy では未確認。

したがって「返る redirectUrl を開いて入金」という手順は **Coinbase の流れ** であって、
Privy でそのまま成立する保証は無い。ここは実行して確かめるしかない。

やること自体は同じ2つ:
- エージェントへの署名許可の付与
- Base Sepolia の testnet USDC の入金（`0x036CbD53842c5426634e7929541eC2318f3dCF7e`）

`provision` は instrument が `ACTIVE` になるまで待つので、
`redirectUrl` が返らなかった場合は Privy 側のダッシュボードなり
テンプレート経由なりで同じ操作を行う。**そこが埋まっていない。**

### 4. 払う

```bash
pip install "bedrock-agentcore[strands-agents]"
python examples/pay_with_strands.py <有料エンドポイントのURL>
```

`examples/pay_with_strands.py` が最小の結線。402 が返るとプラグインが
`ProcessPayment` → 支払いヘッダ付きで再送する。

#### testnet 強制は存在しない（前の版の記述は誤り）

以前ここに「`network_preferences_config` を明示すれば testnet に留まる」と書いた。
**誤りだった。** これは並べ替えのヒントであって制限ではない。

`manager._select_accept_for_instrument_network()` の実装:

```
Step 1: instrument のチェーン族で accepts を絞る
        → _ETHEREUM_NETWORKS には mainnet も testnet も両方入っている（mainnet は落ちない）
Step 2: network_preferences（未指定なら NETWORK_PREFERENCES）
Step 3: preferences の順に一致する accept を返す
Step 4: 一致しなければ filtered_accepts[0] を返す   ← 穴
```

実測（`bedrock-agentcore` 1.22.0 を venv に入れて直接呼んだ）。
売り手が `[Base mainnet, base-sepolia]` の順で提示した 402 に対して:

| 渡した preferences | 選ばれた network |
|---|---|
| 既定（`None`） | `eip155:8453`（Base **mainnet**） |
| `["eip155:84532"]` | `eip155:8453`（Base **mainnet**）← 効かない |
| `["base-sepolia", "eip155:84532"]` | `base-sepolia` ← 効く |
| 売り手が mainnet のみ提示 | `eip155:8453`（**防げない**） |

2 行目が効かないのは、x402 の 402 が network を slug（`"base-sepolia"`）で返すのに
CAIP-2 表記だけを渡すと文字列比較が一致せず、Step 4 に落ちるため。
**slug と CAIP-2 の両方を入れること。**

4 行目が本質的な限界。**売り手が mainnet しか出さなければ mainnet で払う。**
実マネーを防ぐのは設定ではなく次の2つになる:

1. 叩く先を testnet 専用の売り手に限定する（URL を人間が選ぶ）
2. ウォレットに testnet USDC しか入れない（mainnet 残高ゼロなら決済が失敗する。
   「拒否」ではなく「失敗」なので防御としては弱い）

それ以上の拘束が要るなら `auto_payment=False` にして 402 を自前で検査する、
つまり `src/guard/network.ts`（allowlist・deny by default）に戻ることになる。
**独自ハーネスを外すと消えるのはこの保証**、というのが今回はっきりした点。

#### モデルに見えるツールは 2 本ではなく 5 本になる

プラグインを入れると、実測でこれらが登録される:

```
http_request / get_payment_instrument / get_payment_instrument_balance
get_payment_session / list_payment_instruments
```

前方針の「モデルに見せるのは discover と pay の 2 つだけ」は、この構成では成立しない。
決済の芯を借りる代わりに、露出面の設計はプラグイン側の判断に従うことになる。

#### SDK 同梱 README の例には罠がある

`integrations/strands/README.md` の例は `tools=[strands_tools.http_request]` を渡しつつ
`provide_http_request` を既定（True）のままにしている。プラグインも同名のツールを
登録するので、そのままだと Strands のツール登録で名前衝突する。
`examples/pay_with_strands.py` では外部ツールを渡さず、プラグイン内蔵の
`http_request` だけを使うことで回避している。

### 検証済み / 未検証

このセッションで**実行して**確認した:
- `bedrock-agentcore[strands-agents]` 1.22.0 の import 経路
- `AgentCorePaymentsPluginConfig` のフィールド名と `__post_init__` の検証通過
- `AgentCorePaymentsPlugin(config=...)` の構築と登録ツール5本
- `NETWORK_PREFERENCES` の mainnet 先頭

**未検証**（資格情報と egress が無いため）:
- provision の実行そのもの
- Privy の日本での登録可否
- `ProcessPayment` が返す status の実値（SDK 3系は `PROOF_GENERATED` 単一、
  GA docs は `PENDING/SUCCESS/FAILED`。Python SDK は enum を持たず生 dict を返す）
- IAM のアクション名の粒度（`AccessDenied` のメッセージで補正する）

---

## 旧: 独自ハーネスで一周する場合

以下は前方針（独自の2ツールハーネス）向けの記述。実払いの必須ではないが、
per-call 上限・監査ログ・承認記録が要る段階になったら戻ってくる。

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

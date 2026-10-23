# AC-3 結果: upto スキームでの上限の扱い

生成: 2026-10-23T14:50:22+09:00（`npx tsx scripts/report.ts`。値は artifacts/ac3/ からのみ取る）

```
区分   項目                                                値                                                            状態
-----  --------------------------------------------------  ------------------------------------------------------------  ------------------------------------------------------------
AC-3a  上限額 / 実請求額                                   $0.05 / $0.01（模擬売り手 /x402/v2/upto, x402 v2）            設定
AC-3a  自前ガードの減り方                                  16 回通り 17 回目で session_max                               実測（local-signer。上限額で予約→実額で確定）
AC-3a  AgentCore の予算の減り方                            -                                                             未実施（資格情報／provision の出力が無い）
AC-3a  承認額（初回のみ permit2AllowanceLimit）            200000（0.20 USDC。セッション上限と同じ）                     設定
AC-3a  approve の gas 代                                   -                                                             未実施（資格情報／provision の出力が無い）
AC-3a  Permit2 の allowance（試験前 → 試験後 → 縮めた後）  -                                                             未実施（資格情報／provision の出力が無い）
AC-3a  縮めるステップ（approve を 1 に）の gas 代          -                                                             未実施（資格情報／provision の出力が無い）
AC-3a  縮めるステップの予算の減り方                        -                                                             未実施（資格情報／provision の出力が無い）
AC-3a  ウォレット操作の回数（$0.005/回）                   -                                                             未実施（資格情報／provision の出力が無い）
AC-3a  upto facilitator                                    https://x402.org/facilitator（upto on eip155:84532, facilitatorAddress 0xd407e409…）  確認済み（未入金鍵の署名で /verify → permit2_insufficient_balance）
AC-3b  2s の upto（402）                                   上限 2500（amount）/ eip155:8453 / payTo 0x2b6D4988… / facilitator 0x8F5cB67B…  実測（402 のみ。署名していない）
AC-3b  2s の予算の減り方（upto）                           -                                                             未実施（本人判断待ち。--allow-mainnet なしでは署名しない）
AC-3b  2s の承認額（初回のみ permit2AllowanceLimit）       10000（0.01 USDC）                                            設定
AC-3b  2s の approve の gas 代（Base mainnet）             -                                                             未実施（同上）
AC-3b  Permit2 の allowance（試験前 → 試験後 → 縮めた後）  -                                                             未実施（同上）
AC-3b  縮めるステップ（approve を 1 に）の gas 代          -                                                             未実施（同上）
AC-3b  縮めるステップの予算の減り方                        -                                                             未実施（同上）
AC-3b  ウォレット操作の回数（$0.005/回）                   -                                                             未実施（同上）
AC-3b  BlockRun（exact の参照値）                          upto を返さない：exact eip155:8453 2000                       402 のみ実測。支払いは未実施（同上）
```

## 判定の読み方（AC-3a）

セッション上限 $0.20、上限額 $0.05、実請求 $0.01 で繰り返したとき、何回目で止まるかで減り方が分かる。

| 止まる回 | 意味 |
|---|---|
| 5 回目（4 回成功） | 予算は**上限額**で減っている |
| 17 回目（16 回成功） | 実額で計上しつつ、次の呼び出しには**上限額ぶんの空き**を要求している（ハーネスの予約方式と同じ） |
| 21 回目（20 回成功） | 予算は**実額**で減り、空きの要求も実額 |

自前ガードは「上限額で予約 → settle 応答の `amount` で確定 → 差額を解放」に直した（`src/guard/limits.ts` / `src/tools/pay.ts`）。
settle 応答に額が無ければ上限額で確定する（少なく見積もらない）。exact の計上は変えていない（`check:guards` で確認）。

## upto の実装メモ（spec: x402-foundation/x402 specs/schemes/upto/scheme_upto_evm.md）

- Permit2 の `PermitWitnessTransferFrom` に**上限額**で署名する。spender は x402UptoPermit2Proxy `0x4020A4f3…0002`、
  `witness.facilitator` に `extra.facilitatorAddress` を入れる（その facilitator しか settle できない）
- 実額は売り手が handler 実行後に決め、facilitator の `/settle` に `paymentRequirements.amount` で渡す。settle 応答の `amount` に載る
- 買い手は事前に USDC を Permit2 へ approve しておく必要がある。AgentCore では `cryptoX402.permit2AllowanceLimit` を渡すと
  サービスが署名前にオンチェーンで approve を出す（ガスはウォレットのネイティブトークン）。approve は「設定」なので**初回だけ**渡す
  （`src/backends/agentcore.ts` はセッション内の初回 upto だけ `AGENTCORE_PERMIT2_ALLOWANCE_LIMIT` を付ける）

## 承認額と、試験後に残る承認（AC-3a / AC-3b 共通）

- 承認額は総額上限ではなく小さく取る: AC-3a（testnet）は **0.20 USDC（200000）＝セッション上限**、AC-3b の 2s は **0.01 USDC（10000）**。
  BlockRun は exact（EIP-3009）なので承認しない。
- 試験の最後に承認を **1（0.000001 USDC）に縮める**。AgentCore には承認だけを出す API が無く、`permit2AllowanceLimit` は
  正の整数しか受けない（SDK の検証で 0 は拒否）ので、次の手順で行う（`shrinkAllowance` / `shrink_allowance`）:
  1. 試験と同じ allowlist 内の売り手から 402 を取り直す（payTo が allowlist に無ければ何もしない）
  2. upto の accept の金額を 1 に書き換え、`permit2AllowanceLimit="1"` で ProcessPayment を 1 回呼ぶ（上限 $0.01 の専用セッション）。
     サービスが署名の前に approve(Permit2, 1) を出す
  3. このとき生成される支払い署名（paymentOutput）は**どこにも送らず、ログにも残さない**。記録するのは processPaymentId・status・
     承認 tx・gas・予算の変化だけ（`paymentOutput` と `permit2Authorization` は TS の redact / Python の scrub が中身ごと落とし、
     `check:secrets` / `check:keys` が残っていれば落ちる）
  4. RPC で `USDC.allowance(wallet, Permit2)` を読み、1 になったことを確かめる。試験前・試験後・縮めた後の 3 時点を表に残す
- testnet（AC-3a）は自動で実行する。mainnet（AC-3b）は `--allow-mainnet` のときだけ（支払い自体がそのときだけ走る）。
- 承認 tx のハッシュは ProcessPayment が返さないので、USDC の Approval イベント（owner=ウォレット、spender=Permit2）から引く。
  公開 RPC は eth_getLogs を 200 ブロックに制限するので刻んで引いている。
- **完全に 0 にするには、ウォレット側で `USDC.approve(Permit2, 0)` を送る必要がある。AgentCore の API からはできない。**
  試験後に残る承認は 0.000001 USDC（1）。
- AgentCore docs の制約: upto は x402 v2・EVM・`extra.facilitatorAddress` 必須。exact に permit2AllowanceLimit を渡すと ValidationException
- Base Sepolia で upto を提示する公開売り手は見つからなかった（Bazaar の upto 806 件はすべて mainnet）。そのため模擬売り手に upto を足し、
  settle は x402.org facilitator（`MOCK_UPTO_FACILITATOR`）に実際に投げる構成にした

## AC-3b（mainnet）

スクリプトは `scripts/ac3/ac3b_mainnet.py`。売り手は 2 つ。

| 売り手 | エンドポイント | 役割 | 402（支払わずに取得） |
|---|---|---|---|
| 2s | `POST https://2s.io/api/ai/chat` | **upto の実測対象** | exact（Base / Solana）と **upto（Base）**。upto の上限は v2 の `amount`（v1 の maxAmountRequired に当たる） |
| BlockRun | `POST https://blockrun.ai/api/v1/chat/completions` | exact の参照値 | exact のみ |

- 2s の `extra.facilitatorAddress` は **402 ごとに変わる**（CDP facilitator の署名者が入れ替わる。2026-10-20 に
  `0x8F5cB67B…` と `0x68A96F41…` を観測）。upto の署名は `witness.facilitator` をこの値に縛るので、毎回その場の 402 から取る
  （スクリプトは各回 402 を取り直している）。
- 2s の upto では、各回の前後と settle 5 秒後に残予算を取り、1 回あたりの減り方が上限額（$0.0025）か実額かを直接見る
  （上限額が小さいので、セッション上限 $0.20 に当てて回数で見る方法は使わない。既定 3 回）。
- 初回だけ `permit2AllowanceLimit`＝0.01 USDC を渡し、最後に 1 に縮める（上の「承認額と、試験後に残る承認」）。
  Base mainnet で approve が 2 回オンチェーンで出るので、**ウォレットに Base mainnet の ETH が少し要る**。
  ガス代は測る支払い額（1 回 $0.0025 以下）より大きくなる可能性が高い。
- ガード（変えていない）: `--allow-mainnet` が無ければ署名しない／payTo は `config/payto-allowlist.mainnet.json` のうち
  **その売り手の payTo だけ**（2s を払う設定で BlockRun の payTo は通らない。逆も。`npm run check:py` で確認）／
  セッション上限 $0.20／総額 $1.00（`artifacts/ac3/mainnet-ledger.json` に累計。上限額で見積もって超えるなら署名しない）／
  1 回（上限額）$0.05 超は署名しない。

## live で埋める手順

```bash
export AGENTCORE_WALLET_ADDRESS=0x...          # provision の出力（allowance と approve の tx を RPC で引く）
npm run ac3 -- --mode=live --n=20               # 模擬売り手を 8415 で起動し、x402.org facilitator で settle
python scripts/ac3/ac3b_mainnet.py --allow-mainnet   # AC-3b（本人が可とした場合のみ）
npx tsx scripts/report.ts
```

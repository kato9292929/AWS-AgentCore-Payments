# AC-3 結果: upto スキームでの上限の扱い

生成: 2026-10-20T15:15:53+09:00（`npx tsx scripts/report.ts`。値は artifacts/ac3/ からのみ取る）

```
区分   項目                                                 値                                                            状態
-----  ---------------------------------------------------  ------------------------------------------------------------  ------------------------------------------------------------
AC-3a  上限額 / 実請求額                                    $0.05 / $0.01（模擬売り手 /x402/v2/upto, x402 v2）            設定
AC-3a  自前ガードの減り方                                   16 回通り 17 回目で session_max                               実測（local-signer。上限額で予約→実額で確定）
AC-3a  AgentCore の予算の減り方                             -                                                             未実施（資格情報／provision の出力が無い）
AC-3a  approve の gas 代（初回のみ permit2AllowanceLimit）  -                                                             未実施（資格情報／provision の出力が無い）
AC-3a  upto facilitator                                     https://x402.org/facilitator（upto on eip155:84532, facilitatorAddress 0xd407e409…）  確認済み（未入金鍵の署名で /verify → permit2_insufficient_balance）
AC-3b  BlockRun の upto                                     返さない（exact のみ）：exact eip155:8453 2000                実測（402 のみ。署名していない）
AC-3b  mainnet の支払い                                     -                                                             未実施（本人判断待ち。--allow-mainnet なしでは署名しない）
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
- AgentCore docs の制約: upto は x402 v2・EVM・`extra.facilitatorAddress` 必須。exact に permit2AllowanceLimit を渡すと ValidationException
- Base Sepolia で upto を提示する公開売り手は見つからなかった（Bazaar の upto 806 件はすべて mainnet）。そのため模擬売り手に upto を足し、
  settle は x402.org facilitator（`MOCK_UPTO_FACILITATOR`）に実際に投げる構成にした

## AC-3b（mainnet）

- BlockRun（`POST https://blockrun.ai/api/v1/chat/completions`）の 402 を**支払わずに**取った結果は上の表のとおり。
  upto を返していないので、可とされた場合は exact で 1 回払って終える（`scripts/ac3/blockrun_mainnet.py --allow-mainnet`）。
- upto を実際に返している mainnet の売り手は 2s（`POST https://2s.io/api/ai/chat`）。AC-4 の probe に入れてある。
- ガード: `--allow-mainnet` が無ければ署名しない／payTo は `config/payto-allowlist.mainnet.json` の BlockRun のみ／
  セッション上限 $0.20／総額 $1.00（`artifacts/ac3/mainnet-ledger.json` に累計）／1 回 $0.05 超は署名しない。

## live で埋める手順

```bash
export AGENTCORE_WALLET_ADDRESS=0x...          # provision の出力（approve の gas を ETH 残高差で測る）
npm run ac3 -- --mode=live --n=20               # 模擬売り手を 8415 で起動し、x402.org facilitator で settle
npx tsx scripts/report.ts
```

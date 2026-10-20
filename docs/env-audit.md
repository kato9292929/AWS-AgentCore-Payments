# env 監査: MAINNET_* の出どころ（2026-10-20）

**値は一切出していない。** 変数名・置かれている場所・参照箇所だけを書く。変数の削除はしていない（判断は本人）。

## 1. 変数

```
変数名                     名前から見た中身（推測）        このリポジトリでの扱い
-------------------------  ------------------------------  ---------------------------------------------------
MAINNET_BUYER_KEYPAIR      mainnet の買い手の鍵ペア        参照なし（値を読むコードは無い）
MAINNET_DEPLOYER_KEYPAIR   mainnet のデプロイ用の鍵ペア    参照なし
MAINNET_RPC_URL            mainnet の RPC エンドポイント   参照なし
```

- 「KEYPAIR」という名前は Solana の CLI / SDK の慣習に近い。このリポジトリ（EVM / Base）の命名ではないので、
  別のプロジェクト用に環境へ登録されたものに見える（推測。値は見ていない）。
- 同じ環境には、このリポジトリが使わない秘密らしい名前がほかに 3 つある: `NVM_API_KEY_SELLER`、`TYPESAFE_API_KEY`、
  `COLOSSEUM_COPILOT_API_BASE`（最後の 1 つは URL のベースらしく秘密ではないかもしれない）。どれもこのリポジトリからの参照は無い。

## 2. どこで設定されているか

```
確認した場所                                                結果
----------------------------------------------------------  ------------------------------------------------
このリポジトリの .env / .env.*                               無い（.gitignore にも .env はあるが、ファイル自体が無い）
~/.bashrc ~/.bash_profile ~/.profile ~/.zshrc ~/.zprofile   MAINNET_ の記述なし
/etc/environment /etc/profile /etc/bash.bashrc /etc/profile.d  MAINNET_ の記述なし（/etc 全体を grep してもなし）
~/.claude/settings.json・リポジトリの .claude/settings*.json  ファイル無し（env キーなし）
~/.claude.json                                               MAINNET_ の記述なし
Claude Code のシェルスナップショット（~/.claude/shell-snapshots）  MAINNET_ の記述なし
プロセスの環境（/proc/<pid>/environ を親へたどる）           Claude Code 本体のプロセスには無く、
                                                             コマンドを実行するシェルにだけ入っている
```

**結論: クラウド環境の設定（セッションのタイトルバーの環境メニュー → Edit）にある環境変数 / シークレットとして
登録されたものが、コマンド実行時に注入されている。** ファイルとしてはこのコンテナのどこにも書かれていない。
そのため、削除や変更はこのリポジトリやコンテナ内ではなく、その環境設定の画面で行うことになる
（設定を変えたら新しいセッションから反映される）。

確かめ方（値を出さずに名前だけ見る）:

```bash
env | cut -d= -f1 | grep '^MAINNET_'                                         # 名前だけ
p=$$; while [ "$p" -gt 1 ]; do                                               # 祖先プロセスごとの有無
  echo "$p $(tr '\0' '\n' < /proc/$p/environ | cut -d= -f1 | grep -c '^MAINNET_')"; p=$(awk '{print $4}' /proc/$p/stat); done
```

## 3. このリポジトリからの参照

`grep -rn MAINNET_`（node_modules と .git を除く）の結果、**3 つの変数名そのものを参照している箇所は無い**。
`git log --all -S MAINNET_BUYER_KEYPAIR` もヒットなし（過去のコミットにも無い）。

名前の一部「MAINNET」に反応する箇所はある。いずれも**値を読まず、名前があるだけで停止する**側の処理:

```
場所                                    何をするか
--------------------------------------  ---------------------------------------------------------------------------
src/guard/network.ts  assertNoMainnetConfig   env 名に MAINNET を含む変数があれば MainnetDetected を投げて起動時に停止
                                              （ハーネス本体 src/cli.ts、scripts/ac1/run.ts、scripts/ac3/run.ts、provision）
scripts/ac1/d3_client_token.py          MAINNET_* があれば終了コード 2 で停止
scripts/ac2/run.py                      同上
scripts/check-keys-everywhere.ts        秘密らしい env（*_KEYPAIR、*_RPC_URL ほか）の値が artifacts/ と docs/ に
                                        書き出されていないかを照合する。値は比較に使うだけで表示・記録しない
README.md                               「MAINNET_* があるとハーネスは停止する。外した env で測る」の注意書き
```

`src/config.ts` の `MAINNET_CHAINS` と `src/guard/network.ts` の `MAINNET_NETWORK_HINTS` は定数名で、env とは関係ない。

AC-1〜AC-4 の測定は、これらを外した env（`env -u MAINNET_BUYER_KEYPAIR -u MAINNET_DEPLOYER_KEYPAIR -u MAINNET_RPC_URL ...`）で
行った。`npm run check:keys` で、3 つの値がどのログ・ドキュメントにも出ていないことを確認している。

## 4. 判断材料（削除するかどうかは本人）

- このリポジトリの測定には不要。残っていても、ハーネスは起動時に止まるだけで値は使わない。
- ただし、このリポジトリ以外のツールや別の作業がこの環境で走れば、値を読める状態にある
  （環境変数はコマンドを実行する全プロセスに渡る）。mainnet の鍵ペアを testnet 専用の作業環境に置いておく理由が無ければ、
  外すか、それを使うプロジェクト専用の環境に移すのが安全側。
- 外した場合、README の「`env -u MAINNET_...` で測る」は不要になる（守りの停止処理はそのまま残す）。

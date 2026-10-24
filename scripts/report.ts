/**
 * artifacts/ の採取ログから docs/AC1-results.md 〜 AC3-results.md の結果表を作り直す。
 * 表の値は採取ログからだけ取る（手で書き足さない）。採れていない項目は「未実施」と理由を書く。
 *
 *   npx tsx scripts/report.ts            # docs/ に書く
 *   npx tsx scripts/report.ts --stdout   # PR 本文用に表だけ出す
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { toJst } from "./ac4/normalize.js";

type J = Record<string, any>;
const A = (p: string): J | undefined =>
  existsSync(resolve("artifacts", p)) ? (JSON.parse(readFileSync(resolve("artifacts", p), "utf8")) as J) : undefined;

/** 表示幅（全角 2）で詰める */
function w(s: string): number {
  return [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
}
function table(head: string[], rows: string[][]): string {
  const widths = head.map((h, i) => Math.max(w(h), ...rows.map((r) => Math.min(w(r[i] ?? ""), 60))));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c + " ".repeat(Math.max(0, widths[i]! - w(c)))))
      .join("  ")
      .trimEnd();
  return [line(head), widths.map((n) => "-".repeat(n)).join("  "), ...rows.map(line)].join("\n");
}

function notRun(rec: J | undefined, fallback: string): string {
  if (!rec) return `未実施（${fallback}）`;
  return `未実施（${String(rec["reason"] ?? fallback).replace(/: AGENTCORE.*/, "")}）`;
}

// ---------------------------------------------------------------- AC-1
const AC1_ROWS: Array<[string, string, string]> = [
  ["D0", "最初の 1 回（Base Sepolia exact $0.05）", "PROOF_GENERATED か／応答の項目名／残高ゼロで署名できるか"],
  ["D1", "同じ 402・同じ clientToken で 2 回", "2 回目が同じ processPaymentId か／予算は 1 回分か"],
  ["D2", "同じ 402・別の clientToken で 2 回", "2 回とも署名されるか／予算が 2 回分減るか"],
  ["D3", "支払い後に売り手が 30 秒遅延→タイムアウト→再送", "プラグインは clientToken を使い回すか新しく作るか"],
  ["D4", "セッション上限 $0.20 に $0.05 を 5 回（v1, slug）", "5 回目が拒否されるか／拒否時のエラー型"],
  ["D4h", "D4 をハーネス --guards=agentcore-only で", "自前ガードを外しても AgentCore だけで止まるか"],
  ["D5", "セッション有効期限切れの後に呼ぶ", "拒否されるか／エラー型"],
  ["D6", "MPP: 期限切れのチャレンジ", "ValidationException になり予算が減らないか"],
  ["D7", "MPP: feePayer=false で buyerPaysGasFees を渡さない", "ValidationException になるか"],
  ["D8", "testnet（eip155:84532, v2）で D4", "セッション上限が testnet でも効くか"],
];

function ac1Measured(c: string): string {
  if (c === "D3") return d3Summary(A("ac1/D3.json"));
  const r = A(`ac1/${c}.json`);
  if (!r?.["executed"]) return notRun(r, "資格情報なし");
  const f = r["findings"] ?? {};
  switch (c) {
    case "D0":
      return f.proof_generated
        ? `status=${f.status} / 項目 ${JSON.stringify(f.responseFields)} / paymentOutput 直下 ${JSON.stringify(f.paymentOutputMembers)}`
        : `${f.error ? `${f.error.name}(${f.error.httpStatus}): ${String(f.error.message).slice(0, 80)}` : `status=${f.status}`}`;
    case "D1":
      return `同じID=${f.same_processPaymentId} / 予算減 1回目 ${f.budget_delta_1st} 2回目 ${f.budget_delta_2nd}${f.second_call_error ? ` / 2回目エラー ${f.second_call_error.name}` : ""}`;
    case "D2":
      return `両方署名=${f.both_signed} / 別ID=${f.distinct_ids} / 予算減 ${f.budget_delta_1st}, ${f.budget_delta_2nd}`;
    case "D4":
    case "D8":
      return `最初の拒否=${f.first_rejected_call ?? "なし"}回目 / ${f.rejection_error ? `${f.rejection_error.name}(${f.rejection_error.httpStatus}): ${String(f.rejection_error.message).slice(0, 60)}` : "拒否なし"}`;
    case "D4h":
      return `最初のエラー=${f.first_error_index ?? "なし"}回目 / 自前ガード enforced=${f.harness_limit_enforced} / ${JSON.stringify(f.outcomes).slice(0, 80)}`;
    case "D5":
      return `拒否=${f.rejected} / ${f.error ? `${f.error.name}: ${String(f.error.message).slice(0, 60)}` : "-"}`;
    case "D6":
    case "D7":
      return `ValidationException=${f.validation_exception} / 予算不変=${f.budget_unchanged}${c === "D7" ? ` / 対照(feePayer=true) ok=${f.control_ok}` : ""}`;
    default:
      return "-";
  }
}

function d3Summary(d: J | undefined): string {
  if (!d) return "未実施（D3.json なし）";
  const by = (p: string) => (d["results"] as J[]).find((r) => String(r["path"]).includes(p)) ?? {};
  const pl = by("strands-plugin");
  const b0 = by("/b0");
  const b1 = by("/b1");
  const b2 = by("/b2");
  const tok = (r: J) => (r["client_tokens"] ? `${new Set(r["client_tokens"]).size}種/${r["client_tokens"].length}回` : "-");
  return (
    `プラグイン: 毎回新規（token ${tok(pl)}・売り手の決済 ${pl["merchant_settlements"]} 回） / ` +
    `直接 b1(未指定): 新規（${tok(b1)}・決済 ${b1["merchant_settlements"]} 回） / ` +
    `b2(明示): 同一（${tok(b2)}） / b0(ヘッダ再送): 決済 ${b0["merchant_settlements"]} 回` +
    (d["plane"] === "local-fake" ? " ［local-fake: AgentCore 側の冪等性・予算は未測定］" : "")
  );
}

function ac1(): { md: string; tableText: string } {
  const rows = AC1_ROWS.map(([c, what, q]) => [c, what, q, ac1Measured(c)]);
  const t = table(["ケース", "内容", "確かめること", "実測値"], rows);
  const d3 = A("ac1/D3.json");
  const d4h = A("ac1/D4h.json");
  const md = `# AC-1 結果: ProcessPayment の冪等性と、支払いを止める条件

生成: ${toJst(undefined)}（\`npx tsx scripts/report.ts\`。値は artifacts/ac1/*.json からのみ取る）

\`\`\`
${t}
\`\`\`

## 読み方

- ProcessPayment は AWS SDK で**直接**呼ぶ（\`scripts/ac1/run.ts\`）。ハーネスの自前ガード（$0.05 / $0.20）は通らないので、
  D1〜D8 の拒否はすべて AgentCore 側の挙動になる。D4h だけはハーネス経由で \`--guards=agentcore-only\` にしたもの。
- 402 は模擬売り手（\`mock/server.ts\`）から取る。売り手への再送はしない（D3 を除く）。売り手側の egress も入金も要らない。
- 残予算は \`GetPaymentSession\` の \`availableLimits.availableSpendAmount\`（呼ぶ前・呼んだ後）。
- 未実施のケースにも、送るはずだった入力（\`plannedInputs\`）を artifacts/ac1/<case>.json に残してある。

## D3 の詳細（${d3?.["plane"] ?? "-"}）

${d3 ? `測った範囲: ${d3["scope"]}

| 経路 | ProcessPayment に渡った clientToken | 使い回し | 売り手で成立した決済 |
|---|---|---|---|
${(d3["results"] as J[])
  .map(
    (r) =>
      `| ${r["path"]}${r["variant"] ? `（${r["variant"]}）` : ""} | ${(r["client_tokens"] ?? []).map((t: string) => `\`${t.slice(0, 13)}…\``).join(", ")} | ${r["client_token_reused"]} | ${r["merchant_settlements"]} |`,
  )
  .join("\n")}

- SDK ${JSON.stringify(d3["sdk"])}。プラグインの \`_process_payment_required_request\` は呼ぶたびに \`client_token=str(uuid.uuid4())\` を渡す
  （bedrock_agentcore/payments/integrations/strands/plugin.py）。\`generate_payment_header\` も未指定なら毎回 \`uuid4()\` を作る。
- プラグインの \`http_request\` は httpx の timeout 30 秒固定。30 秒遅れる売り手に対しては 1 回目の再送がタイムアウトし、
  \`statusCode: 0\` がモデルに返る。402 ではないのでプラグインは再署名しない。**モデルがもう一度 http_request を呼ぶと、
  新しい 402 に対して新しい clientToken で ProcessPayment が走る**（台本で再現。売り手では 2 回決済が成立した）。
- b0（同じヘッダをそのまま再送）は売り手が \`nonce_already_used\` で 402 を返し、二重決済にならない。
- b2 で売り手の決済が 2 回になっているのは local-fake が毎回署名し直すため。AgentCore が同じ clientToken に同じ証明を返すなら
  （＝D1 が「同じID」なら）、2 回目の再送は b0 と同じく nonce 使用済みで拒否されるはず。live で確かめる項目。` : "D3.json なし"}

## D4h（ハーネス経由・agentcore-only）

${d4h?.["executed"] ? "```\n" + JSON.stringify(d4h["findings"], null, 2) + "\n```" : notRun(d4h, "資格情報なし")}

## live で埋めるときの手順

\`\`\`bash
npm run mock:merchant &                        # 別ターミナル
export AWS_REGION=us-east-1 AGENTCORE_PAYMENT_MANAGER_ARN=... AGENTCORE_PAYMENT_INSTRUMENT_ID=... \\
       AGENTCORE_PAYMENT_SESSION_ID=... PAYMENT_USER_EMAIL=...
npm run ac1                                    # D1 D2 D4 D4h D6 D7 D8
npm run ac1 -- --cases=D5                      # 16 分待つ
python scripts/ac1/d3_client_token.py --plane=live
npx tsx scripts/report.ts
\`\`\`
`;
  return { md, tableText: t };
}

// ---------------------------------------------------------------- AC-2
function ac2(): { md: string; tableText: string } {
  const s = A("ac2/summary.json");
  const cw = A("ac2/cloudwatch.json");
  const live = s?.["plane"] === "live";
  const x = s?.["x402"] ?? {};
  const tx = (x["tx"] ?? []) as J[];
  const rows: string[][] = [
    ["売り手", "https://x402.org/protected（x402 v2 exact, eip155:84532, $0.01）", "選定済み（2026-10-20 の 402 で確認）"],
    ["支払い先 allowlist", "config/payto-allowlist.json 以外の payTo には署名しない", "実測（テスト: run-all payto-not-allowlisted / check:py）"],
    [
      "402→200 の時間（10 回）",
      live ? `中央値 ${x["latency_ms_median"]} ms（${x["latency_ms_min"]}〜${x["latency_ms_max"]}）、ProcessPayment 中央値 ${x["process_payment_ms_median"]} ms` : "-",
      live ? `実測 ${x["delivered"]}/${x["attempted"]}` : "未実施（AgentCore の資格情報なし）",
    ],
    [
      "settle の tx と金額",
      live && tx.length ? tx.slice(0, 2).map((t) => `${String(t["tx_hash"]).slice(0, 12)}… ${t["settled_amount"]}`).join(", ") + (tx.length > 2 ? ` ほか ${tx.length - 2} 件` : "") : "-",
      live ? `オンチェーン照合 ${tx.filter((t) => t["onchain_status"] === 1).length}/${tx.length}` : "未実施（AgentCore の資格情報なし）",
    ],
    [
      "MPP",
      s?.["seller_offers_mpp"] ? "売り手が MPP を返す" : "x402.org は MPP チャレンジを返さない",
      s?.["mpp"]?.["executed"] === false || !s ? "未実施（testnet で MPP を返す公開売り手が見つからない）" : `実測 ${s["mpp"]["delivered"]}/${s["mpp"]["attempted"]}`,
    ],
    [
      "Strands プラグイン経由",
      live ? `final_status=${s?.["plugin"]?.["final_status"]}` : "-",
      live ? "実測（台本モデル）" : "未実施（AgentCore の資格情報なし）",
    ],
    [
      "CloudWatch の項目名",
      cw?.["metrics"] ? Object.entries(cw["metrics"] as J).map(([ns, m]) => `${ns}: ${Object.keys(m).join(",")}`).join(" / ").slice(0, 120) : "-",
      cw?.["metrics"] ? `実測（ログのキー ${Object.keys(cw["log_field_names"] ?? {}).length} 種）` : "未実施（AgentCore の資格情報なし。docs 記載の名前は下に）",
    ],
  ];
  const t = table(["項目", "値", "状態"], rows);
  const md = `# AC-2 結果: Coinbase 経路での実払いの一周（T4/T5）

生成: ${toJst(undefined)}（\`npx tsx scripts/report.ts\`。値は artifacts/ac2/ からのみ取る）

\`\`\`
${t}
\`\`\`

## 売り手の選定

| 候補 | 402 | 採否 |
|---|---|---|
| **https://x402.org/protected** | v2 / \`PAYMENT-REQUIRED\` ヘッダ / exact / eip155:84532 / 10000（$0.01）/ payTo 0x209693Bc…287C / extra {name:"USDC",version:"2"} / Solana devnet の accept も併記 | **採用**。x402 の仕様リポジトリを持つ x402.org が運営、testnet 専用、少額 |
| https://x402.payai.network/api/base-sepolia/paid-content | v2 exact eip155:84532 $0.01 | 予備 1 |
| https://x402.nodeventures.io/check | v2 exact eip155:84532 $0.005 | 予備 2（小規模の第三者） |

egress に必要なホストは \`x402.org\` だけ（再送も同じホスト。settle は売り手側の facilitator が行う）。
オンチェーン照合に \`sepolia.base.org\`（Base Sepolia の公開 RPC）を使う。

## ${live ? "実測ログ" : "未実施の理由と、埋める手順"}

${live ? "artifacts/ac2/runs.jsonl（1 行 1 回）、summary.json、cloudwatch.json。" : `AWS の資格情報（env にあるものは \`InvalidClientTokenId\`）と provision の出力が無いため、ProcessPayment を呼べていない。
結線は AgentCore の代わりに LocalPlane（\`scripts/py/planes.py\`。EIP-3009 を実署名）をつないで、模擬売り手の v2 売り場で一周させて確認済み
（\`python scripts/ac2/run.py --plane=local --url=http://127.0.0.1:8402/x402/v2/weather --n=3 --out=/tmp/ac2-selftest\`）。これは実測ではないので artifacts には置いていない。`}

\`\`\`bash
python scripts/ac2/cloudwatch.py --setup                     # vended logs の delivery（初回だけ）
python scripts/ac2/run.py --url=https://x402.org/protected --n=10
python examples/pay_with_strands.py --scripted https://x402.org/protected   # 指示書どおりの 1 周（LLM 無し）
python scripts/ac2/cloudwatch.py --collect
npx tsx scripts/report.ts
\`\`\`

## CloudWatch（docs 記載。実物の名前は cloudwatch.json で上書きする）

- メトリクス: OperationSuccess, OperationFailure, OperationLatency, SpendAmount, Throttles, UserErrors, ActiveSessions,
  PaymentRequestCount, PaymentSuccessCount, PaymentFailureCount, PaymentLatency
- ディメンション: Operation, PaymentManagerId, PaymentConnectorId, AgentName, Currency
- 名前空間: payments のページに明記なし（AgentCore 全般は \`AWS/Bedrock-AgentCore\`）。\`cloudwatch.py\` は名前空間を決め打ちせず
  PaymentManagerId ディメンションで引く
- vended logs: 既定のロググループ無し。フィールド名は docs に無い（\`cloudwatch.py --collect\` で実物のキーを集める）
- スパン: \`Bedrock.AgentCore.Payments.<Operation>\`、属性 \`aws.payments.*\`（spend_amount, session_remaining_budget, merchant ほか）
`;
  return { md, tableText: t };
}

// ---------------------------------------------------------------- AC-3
/** 承認額の 3 時点（試験前・試験後・縮めた後）と、縮めるステップの gas・予算・ウォレット操作回数の行。 */
function allowanceRows(label: string, d: J | undefined, state: string): string[][] {
  const a = d?.["allowance_permit2"] ?? {};
  const sh = d?.["shrink"] ?? {};
  const ops = d?.["wallet_operations"] ?? {};
  const n = Number(ops["test_process_payment"] ?? 0) + Number(ops["shrink_process_payment"] ?? 0);
  return [
    [
      label,
      "Permit2 の allowance（試験前 → 試験後 → 縮めた後）",
      d ? `${a["before_test"] ?? "-"} → ${a["after_test"] ?? "-"} → ${a["after_shrink"] ?? "-"}（${sh["allowance_is_1"] ? "1 を確認" : "1 を確認できず"}）` : "-",
      state,
    ],
    [
      label,
      "縮めるステップ（approve を 1 に）の gas 代",
      d ? `${sh["approve_gas_eth"] ?? "-"} ETH（tx ${String(sh["approve_tx"]?.["txHash"] ?? "-").slice(0, 12)}…）` : "-",
      state,
    ],
    [label, "縮めるステップの予算の減り方", d ? `${sh["budget_before"] ?? "-"} → ${sh["budget_after"] ?? "-"}（専用セッション $0.01）` : "-", state],
    [
      label,
      "ウォレット操作の回数（$0.005/回）",
      d ? `試験 ${ops["test_process_payment"] ?? 0} 回 + 縮める 1 回 = ${n} 回（$${(n * 0.005).toFixed(3)}）` : "-",
      state,
    ],
  ];
}

function ac3(): { md: string; tableText: string } {
  const h = A("ac3/harness-local.json");
  const fp = A("ac3/facilitator-probe.json");
  const lv = A("ac3/live.json");
  const b3 = A("ac3/ac3b-mainnet.json");
  const s2 = b3?.["sellers"]?.["2s"] as J | undefined;
  const br = b3?.["sellers"]?.["blockrun"] as J | undefined;
  const uptoOffer = (s2?.["probe"]?.["accepts"] as J[] | undefined)?.find((a) => a["scheme"] === "upto");
  const paidRuns = (sel: J | undefined) => ((sel?.["runs"] ?? []) as J[]).filter((r) => r["http_status"]);
  const liveRan = lv?.["executed"] === true;
  const rows: string[][] = [
    ["AC-3a", "上限額 / 実請求額", "$0.05 / $0.01（模擬売り手 /x402/v2/upto, x402 v2）", "設定"],
    [
      "AC-3a",
      "自前ガードの減り方",
      h ? `${h["successful_payments"]} 回通り ${h["first_declined_call"]} 回目で ${h["decline_rule"]}` : "-",
      h ? "実測（local-signer。上限額で予約→実額で確定）" : "未実施",
    ],
    [
      "AC-3a",
      "AgentCore の予算の減り方",
      liveRan ? `${lv!["successful_calls"]} 回成功、最初の拒否 ${lv!["first_rejected_call"] ?? "なし"} 回目（4=上限額 / 16=実額+空き要求 / 20=実額）` : "-",
      liveRan ? "実測" : notRun(lv, "資格情報なし"),
    ],
    ["AC-3a", "承認額（初回のみ permit2AllowanceLimit）", "200000（0.20 USDC。セッション上限と同じ）", "設定"],
    ["AC-3a", "approve の gas 代", liveRan ? `${lv!["approve_gas_eth"] ?? "-"} ETH` : "-", liveRan ? "実測" : notRun(lv, "資格情報なし")],
    ...allowanceRows("AC-3a", liveRan ? lv : undefined, liveRan ? "実測" : notRun(lv, "資格情報なし")),
    [
      "AC-3a",
      "upto facilitator",
      fp ? `${fp["facilitator"]}（upto on eip155:84532, facilitatorAddress ${String(fp["supported_upto_base_sepolia"]?.["extra"]?.["facilitatorAddress"] ?? "-").slice(0, 10)}…）` : "-",
      fp ? `確認済み（未入金鍵の署名で /verify → ${fp["resend_body"]?.["facilitator"]?.["invalidReason"] ?? fp["resend_status"]}）` : "未確認",
    ],
    [
      "AC-3b",
      "2s の upto（402）",
      uptoOffer
        ? `上限 ${uptoOffer["maxAmountRequired"]}（${uptoOffer["field"]}）/ ${uptoOffer["network"]} / payTo ${String(uptoOffer["payTo"]).slice(0, 10)}… / facilitator ${String(uptoOffer["facilitatorAddress"]).slice(0, 10)}…`
        : s2 ? "upto を返さない" : "-",
      s2 ? "実測（402 のみ。署名していない）" : "未実施",
    ],
    [
      "AC-3b",
      "2s の予算の減り方（upto）",
      s2?.["paid"] ? paidRuns(s2).map((r) => `${r["budget_before"]}→${r["budget_after_settle_5s"]}`).join(", ") : "-",
      s2?.["paid"] ? "実測" : "未実施（本人判断待ち。--allow-mainnet なしでは署名しない）",
    ],
    ["AC-3b", "2s の承認額（初回のみ permit2AllowanceLimit）", "10000（0.01 USDC）", "設定"],
    [
      "AC-3b",
      "2s の approve の gas 代（Base mainnet）",
      s2?.["paid"] ? `${s2["approve_gas_eth"] ?? "-"} ETH` : "-",
      s2?.["paid"] ? "実測" : "未実施（同上）",
    ],
    ...allowanceRows("AC-3b", s2?.["paid"] ? s2 : undefined, s2?.["paid"] ? "実測" : "未実施（同上）"),
    [
      "AC-3b",
      "BlockRun（exact の参照値）",
      br
        ? `${br["probe"]["offers_upto"] ? "upto を返す" : "upto を返さない"}：${(br["probe"]["accepts"] as J[]).map((a) => `${a["scheme"]} ${a["network"]} ${a["maxAmountRequired"]}`).join(", ")}${br["paid"] ? ` / 支払い ${paidRuns(br).length} 回` : ""}`
        : "-",
      br?.["paid"] ? "実測" : br ? "402 のみ実測。支払いは未実施（同上）" : "未実施",
    ],
  ];
  const t = table(["区分", "項目", "値", "状態"], rows);
  const md = `# AC-3 結果: upto スキームでの上限の扱い

生成: ${toJst(undefined)}（\`npx tsx scripts/report.ts\`。値は artifacts/ac3/ からのみ取る）

\`\`\`
${t}
\`\`\`

## 判定の読み方（AC-3a）

セッション上限 $0.20、上限額 $0.05、実請求 $0.01 で繰り返したとき、何回目で止まるかで減り方が分かる。

| 止まる回 | 意味 |
|---|---|
| 5 回目（4 回成功） | 予算は**上限額**で減っている |
| 17 回目（16 回成功） | 実額で計上しつつ、次の呼び出しには**上限額ぶんの空き**を要求している（ハーネスの予約方式と同じ） |
| 21 回目（20 回成功） | 予算は**実額**で減り、空きの要求も実額 |

自前ガードは「上限額で予約 → settle 応答の \`amount\` で確定 → 差額を解放」に直した（\`src/guard/limits.ts\` / \`src/tools/pay.ts\`）。
settle 応答に額が無ければ上限額で確定する（少なく見積もらない）。exact の計上は変えていない（\`check:guards\` で確認）。

## upto の実装メモ（spec: x402-foundation/x402 specs/schemes/upto/scheme_upto_evm.md）

- Permit2 の \`PermitWitnessTransferFrom\` に**上限額**で署名する。spender は x402UptoPermit2Proxy \`0x4020A4f3…0002\`、
  \`witness.facilitator\` に \`extra.facilitatorAddress\` を入れる（その facilitator しか settle できない）
- 実額は売り手が handler 実行後に決め、facilitator の \`/settle\` に \`paymentRequirements.amount\` で渡す。settle 応答の \`amount\` に載る
- 買い手は事前に USDC を Permit2 へ approve しておく必要がある。AgentCore では \`cryptoX402.permit2AllowanceLimit\` を渡すと
  サービスが署名前にオンチェーンで approve を出す（ガスはウォレットのネイティブトークン）。approve は「設定」なので**初回だけ**渡す
  （\`src/backends/agentcore.ts\` はセッション内の初回 upto だけ \`AGENTCORE_PERMIT2_ALLOWANCE_LIMIT\` を付ける）

## 承認額と、試験後に残る承認（AC-3a / AC-3b 共通）

- 承認額は総額上限ではなく小さく取る: AC-3a（testnet）は **0.20 USDC（200000）＝セッション上限**、AC-3b の 2s は **0.01 USDC（10000）**。
  BlockRun は exact（EIP-3009）なので承認しない。
- 試験の最後に承認を **1（0.000001 USDC）に縮める**。AgentCore には承認だけを出す API が無く、\`permit2AllowanceLimit\` は
  正の整数しか受けない（SDK の検証で 0 は拒否）ので、次の手順で行う（\`shrinkAllowance\` / \`shrink_allowance\`）:
  1. 試験と同じ allowlist 内の売り手から 402 を取り直す（payTo が allowlist に無ければ何もしない）
  2. upto の accept の金額を 1 に書き換え、\`permit2AllowanceLimit="1"\` で ProcessPayment を 1 回呼ぶ（上限 $0.01 の専用セッション）。
     サービスが署名の前に approve(Permit2, 1) を出す
  3. このとき生成される支払い署名（paymentOutput）は**どこにも送らず、ログにも残さない**。記録するのは processPaymentId・status・
     承認 tx・gas・予算の変化だけ（\`paymentOutput\` と \`permit2Authorization\` は TS の redact / Python の scrub が中身ごと落とし、
     \`check:secrets\` / \`check:keys\` が残っていれば落ちる）
  4. RPC で \`USDC.allowance(wallet, Permit2)\` を読み、1 になったことを確かめる。試験前・試験後・縮めた後の 3 時点を表に残す
- testnet（AC-3a）は自動で実行する。mainnet（AC-3b）は \`--allow-mainnet\` のときだけ（支払い自体がそのときだけ走る）。
- 承認 tx のハッシュは ProcessPayment が返さないので、USDC の Approval イベント（owner=ウォレット、spender=Permit2）から引く。
  公開 RPC は eth_getLogs を 200 ブロックに制限するので刻んで引いている。
- **完全に 0 にするには、ウォレット側で \`USDC.approve(Permit2, 0)\` を送る必要がある。AgentCore の API からはできない。**
  試験後に残る承認は 0.000001 USDC（1）。
- AgentCore docs の制約: upto は x402 v2・EVM・\`extra.facilitatorAddress\` 必須。exact に permit2AllowanceLimit を渡すと ValidationException
- Base Sepolia で upto を提示する公開売り手は見つからなかった（Bazaar の upto 806 件はすべて mainnet）。そのため模擬売り手に upto を足し、
  settle は x402.org facilitator（\`MOCK_UPTO_FACILITATOR\`）に実際に投げる構成にした

## AC-3b（mainnet）

スクリプトは \`scripts/ac3/ac3b_mainnet.py\`。売り手は 2 つ。

| 売り手 | エンドポイント | 役割 | 402（支払わずに取得） |
|---|---|---|---|
| 2s | \`POST https://2s.io/api/ai/chat\` | **upto の実測対象** | exact（Base / Solana）と **upto（Base）**。upto の上限は v2 の \`amount\`（v1 の maxAmountRequired に当たる） |
| BlockRun | \`POST https://blockrun.ai/api/v1/chat/completions\` | exact の参照値 | exact のみ |

- 2s の \`extra.facilitatorAddress\` は **402 ごとに変わる**（CDP facilitator の署名者が入れ替わる。2026-10-20 に
  \`0x8F5cB67B…\` と \`0x68A96F41…\` を観測）。upto の署名は \`witness.facilitator\` をこの値に縛るので、毎回その場の 402 から取る
  （スクリプトは各回 402 を取り直している）。
- 2s の upto では、各回の前後と settle 5 秒後に残予算を取り、1 回あたりの減り方が上限額（$0.0025）か実額かを直接見る
  （上限額が小さいので、セッション上限 $0.20 に当てて回数で見る方法は使わない。既定 3 回）。
- 初回だけ \`permit2AllowanceLimit\`＝0.01 USDC を渡し、最後に 1 に縮める（上の「承認額と、試験後に残る承認」）。
  Base mainnet で approve が 2 回オンチェーンで出るので、**ウォレットに Base mainnet の ETH が少し要る**。
  ガス代は測る支払い額（1 回 $0.0025 以下）より大きくなる可能性が高い。
- ガード（変えていない）: \`--allow-mainnet\` が無ければ署名しない／payTo は \`config/payto-allowlist.mainnet.json\` のうち
  **その売り手の payTo だけ**（2s を払う設定で BlockRun の payTo は通らない。逆も。\`npm run check:py\` で確認）／
  セッション上限 $0.20／総額 $1.00（\`artifacts/ac3/mainnet-ledger.json\` に累計。上限額で見積もって超えるなら署名しない）／
  1 回（上限額）$0.05 超は署名しない。

## live で埋める手順

\`\`\`bash
export AGENTCORE_WALLET_ADDRESS=0x...          # provision の出力（allowance と approve の tx を RPC で引く）
npm run ac3 -- --mode=live --n=20               # 模擬売り手を 8415 で起動し、x402.org facilitator で settle
python scripts/ac3/ac3b_mainnet.py --allow-mainnet   # AC-3b（本人が可とした場合のみ）
npx tsx scripts/report.ts
\`\`\`
`;
  return { md, tableText: t };
}

const out = { ac1: ac1(), ac2: ac2(), ac3: ac3() };
if (process.argv.includes("--stdout")) {
  process.stdout.write(
    `### AC-1\n\`\`\`\n${out.ac1.tableText}\n\`\`\`\n\n### AC-2\n\`\`\`\n${out.ac2.tableText}\n\`\`\`\n\n### AC-3\n\`\`\`\n${out.ac3.tableText}\n\`\`\`\n`,
  );
} else {
  writeFileSync("docs/AC1-results.md", out.ac1.md);
  writeFileSync("docs/AC2-results.md", out.ac2.md);
  writeFileSync("docs/AC3-results.md", out.ac3.md);
  process.stdout.write("docs/AC1-results.md, AC2-results.md, AC3-results.md を更新\n");
}

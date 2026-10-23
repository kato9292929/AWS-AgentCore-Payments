/**
 * AC-1〜AC-3 で足したガードの単体確認（サーバ不要）。
 *   - 支払い先 allowlist（payTo × network）
 *   - upto の予約と確定（上限額で押さえ、実額で確定、差額を解放）
 *   - exact の計上は従来どおり（成立後に金額をそのまま計上）
 *   - --guards=agentcore-only は判定を残して止めない
 *   - x402 v2（PAYMENT-REQUIRED ヘッダ）の読み取りと testnet 判定
 *   - AC-3a の承認を 1 に縮めるステップ（署名を残さない・allowlist・縮めた後の allowance）
 */
import { loadConfig, usdToAtomic } from "../src/config.js";
import { SpendLimiter } from "../src/guard/limits.js";
import { assertTestnetNetwork, MainnetDetected } from "../src/guard/network.js";
import { PayToAllowlist } from "../src/guard/payToAllowlist.js";
import { parse402 } from "../src/rails/x402.js";
import { shrinkAllowance } from "./ac3/allowance.js";

const results: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown): void => {
  results.push({ name, ok, ...(ok ? {} : { detail }) });
};

// ---- payTo allowlist ----
const MOCK_PAYTO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const allow = PayToAllowlist.load("config/payto-allowlist.json");
check("payTo: mock の payTo × base-sepolia は通す", allow.check({ payTo: MOCK_PAYTO, network: "base-sepolia" }).allowed);
check(
  "payTo: 同じ payTo × eip155:84532（CAIP-2）も通す",
  allow.check({ payTo: MOCK_PAYTO.toLowerCase(), network: "eip155:84532" }).allowed,
);
const other = allow.check({ payTo: "0x000000000000000000000000000000000000dEaD", network: "base-sepolia" });
check("payTo: 無い payTo は拒否", !other.allowed && other.reason === "payto_not_allowlisted", other);
const mainnet = allow.check({ payTo: MOCK_PAYTO, network: "eip155:8453" });
check(
  "payTo: allowlist の payTo でも mainnet の network は拒否",
  !mainnet.allowed && mainnet.reason === "network_not_allowlisted_for_payto",
  mainnet,
);

// ---- 上限（exact は従来どおり） ----
process.env["PER_CALL_MAX_USD"] = "0.05";
process.env["SESSION_MAX_USD"] = "0.20";
const cfg = loadConfig();
{
  const l = new SpendLimiter(cfg);
  let ok = 0;
  for (let i = 0; i < 5; i++) {
    if (l.evaluate(usdToAtomic("0.05")).verdict !== "within") break;
    l.commit(usdToAtomic("0.05"));
    ok += 1;
  }
  const fifth = l.evaluate(usdToAtomic("0.05"));
  check("exact: $0.05 × 4 回で $0.20 に達し、5 回目は session_max", ok === 4 && "rule" in fifth && fifth.rule === "session_max", {
    ok,
    fifth,
  });
}

// ---- upto: 上限額で予約、実額で確定 ----
{
  const l = new SpendLimiter(cfg);
  const cap = usdToAtomic("0.05");
  const actual = usdToAtomic("0.01");
  let n = 0;
  for (let i = 0; i < 25; i++) {
    if (l.evaluate(cap).verdict !== "within") break;
    const r = l.reserve(cap);
    const s = l.settle(r, actual);
    if (s.released !== usdToAtomic("0.04")) break;
    n += 1;
  }
  check("upto: 上限 $0.05 / 実額 $0.01 / セッション $0.20 で 16 回通り 17 回目で止まる", n === 16, { n });
  check("upto: 確定後の使用済みは実額の合計（$0.16）", l.spent === usdToAtomic("0.16") && l.reserved === 0n, {
    spent: l.spent,
    reserved: l.reserved,
  });
}
{
  const l = new SpendLimiter(cfg);
  const r = l.reserve(usdToAtomic("0.05"));
  check("upto: 予約中は残りが上限額ぶん減って見える", l.remaining === usdToAtomic("0.15"));
  l.release(r);
  check("upto: 決済に至らなければ予約を全額解放する", l.remaining === usdToAtomic("0.20") && l.spent === 0n);
  const r2 = l.reserve(usdToAtomic("0.05"));
  const over = l.settle(r2, usdToAtomic("0.06"));
  check("upto: 上限額を超える実額は overcharge として返す", over.overcharge === usdToAtomic("0.01"), over);
}

// ---- agentcore-only ----
{
  const l = new SpendLimiter(cfg, { guards: "agentcore-only" });
  const d = l.evaluate(usdToAtomic("0.50"));
  check(
    "agentcore-only: 判定は per_call_max を返すが enforcing=false",
    !l.enforcing && d.verdict === "limit_exceeded" && "rule" in d && d.rule === "per_call_max",
    d,
  );
  check("既定（both）は enforcing=true", new SpendLimiter(cfg).enforcing);
}

// ---- x402 v2 の読み取り ----
{
  const required = {
    x402Version: 2,
    resource: { url: "https://example.test/x" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532",
        amount: "10000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: MOCK_PAYTO,
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
  const { demand } = parse402({
    status: 402,
    headers: { "payment-required": Buffer.from(JSON.stringify(required)).toString("base64") },
    bodyText: "{}",
  });
  check(
    "x402 v2: PAYMENT-REQUIRED ヘッダから amount と CAIP-2 network を読む",
    demand.amountAtomic === 10000n &&
      demand.network === "eip155:84532" &&
      demand.raw.kind === "x402" &&
      demand.raw.transport === "v2-header",
    demand,
  );
  let halted = false;
  try {
    assertTestnetNetwork("eip155:8453");
  } catch (e) {
    halted = e instanceof MainnetDetected;
  }
  check("network: eip155:8453（Base mainnet）は停止側", halted);
}

// ---- AC-3a: 試験の最後に Permit2 の承認を 1 に縮める（偽の AgentCore と偽のチェーン。通信なし） ----
{
  const FAKE_SIG = `0x${"ab".repeat(65)}`;
  let allowanceNow = 200000n;
  let approvedAt: bigint | null = null;
  const sent: Array<Record<string, any>> = [];
  const plane = {
    send: async (cmd: { input: Record<string, any> }) => {
      sent.push(cmd.input);
      allowanceNow = BigInt(cmd.input["paymentInput"]["cryptoX402"]["permit2AllowanceLimit"]);
      approvedAt = 101n;
      return { processPaymentId: "pp-shrink", status: "PROOF_GENERATED", paymentOutput: { cryptoX402: { payload: { signature: FAKE_SIG } } } };
    },
  };
  const chain = {
    getBlockNumber: async () => 101n,
    readContract: async () => allowanceNow,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
      approvedAt !== null && approvedAt >= fromBlock && approvedAt <= toBlock
        ? [{ transactionHash: `0x${"cd".repeat(32)}`, blockNumber: approvedAt, args: { value: allowanceNow } }]
        : [],
    getTransactionReceipt: async () => ({ gasUsed: 50000n, effectiveGasPrice: 10n }),
  } as unknown as Parameters<typeof shrinkAllowance>[0]["chain"];
  const opened: string[] = [];
  const closed: string[] = [];
  const deps = (payTo: string) => ({
    plane: plane as never,
    chain,
    managerArn: "arn:aws:bedrock-agentcore:us-east-1:000000000000:payment-manager/x",
    instrumentId: "inst",
    userId: "user",
    wallet: "0x00000000000000000000000000000000000000Aa" as const,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const,
    payTo: allow,
    fresh402: async () => ({
      accepts: [{ scheme: "upto", network: "eip155:84532", amount: "50000", payTo, extra: { facilitatorAddress: "0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf" } }],
    }),
    openSession: async (maxUsd: string) => {
      opened.push(maxUsd);
      return "shrink-session";
    },
    budgetOf: async () => "0.01 USD",
    closeSession: async (sid: string) => {
      closed.push(sid);
    },
  });
  const out = await shrinkAllowance(deps(MOCK_PAYTO));
  const cx = sent[0]?.["paymentInput"]?.["cryptoX402"] ?? {};
  const text = JSON.stringify(out);
  check(
    "shrink: upto・署名額 1・permit2AllowanceLimit=\"1\" で ProcessPayment を 1 回",
    sent.length === 1 && cx.payload?.scheme === "upto" && cx.payload?.amount === "1" && cx.permit2AllowanceLimit === "1",
    sent,
  );
  check("shrink: 専用セッション（$0.01）を開いて閉じる", opened.join() === "0.01" && closed.join() === "shrink-session", { opened, closed });
  check("shrink: 結果に支払い署名（paymentOutput / signature）を残さない", !text.includes("paymentOutput") && !text.includes(FAKE_SIG), out);
  check(
    "shrink: processPaymentId・status・承認 tx・gas を残す",
    out["processPaymentId"] === "pp-shrink" && out["status"] === "PROOF_GENERATED" && Boolean(out["approve_tx"]) && out["approve_gas_eth"] === "0.0000000000005",
    out,
  );
  check("shrink: 縮めた後の allowance を RPC で読んで 1", out["allowance_before"] === "200000" && out["allowance_after"] === "1" && out["allowance_is_1"] === true, out);
  const before = sent.length;
  const rejected = await shrinkAllowance(deps("0x000000000000000000000000000000000000dEaD"));
  check("shrink: allowlist に無い payTo の 402 なら ProcessPayment を呼ばない", rejected["executed"] === false && sent.length === before, rejected);
}

const ng = results.filter((r) => !r.ok);
if (ng.length > 0) {
  console.error(JSON.stringify({ check: "guards", result: "NG", failed: ng }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  process.exit(1);
}
console.log(JSON.stringify({ check: "guards", result: "ok", cases: results.map((r) => r.name) }, null, 2));

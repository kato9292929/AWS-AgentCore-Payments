/**
 * AC-3a: upto（上限額だけ決めて、実際に使った分を請求される方式）で、
 * セッション予算が「上限額」と「実請求額」のどちらで減るかを測る。
 *
 * 売り手は模擬売り手の /x402/v2/upto（x402 v2、上限 $0.05、実請求 $0.01、extra.facilitatorAddress あり）。
 * セッション上限 $0.20 に対して繰り返し、何回目で拒否されるかを見る。
 *   4 回で止まる  → 上限額で減っている
 *   16 回で止まる → 実額で計上しつつ、次の呼び出しの上限額ぶんの空きを要求している（ハーネスの予約方式と同じ）
 *   20 回で止まる → 実額で減っている
 *
 * モード:
 *   --mode=harness-local     自前ガード（上限額で予約 → 実額で確定）だけを local-signer で測る。資格情報不要。
 *   --mode=facilitator-probe 模擬売り手を x402.org facilitator に実際につないで（MOCK_UPTO_FACILITATOR）、
 *                            local-signer の upto 署名を /verify に投げる。残高も Permit2 の approve も無い鍵なので
 *                            facilitator が何と言って断るかを記録する（facilitator が使えるかの確認）。資格情報不要。
 *   --mode=live              AgentCore の ProcessPayment を直接呼ぶ。初回だけ permit2AllowanceLimit を渡す。
 *                            模擬売り手は x402.org facilitator で実際に settle する（Base Sepolia）。
 *                            各回の前後と settle 後に GetPaymentSession の残予算を取る。
 *                            初回の approve のガス代は、ウォレットの ETH 残高の差で測る。
 *
 * 出力: artifacts/ac3/<mode>.json
 */
import {
  BedrockAgentCoreClient,
  CreatePaymentSessionCommand,
  DeletePaymentSessionCommand,
  GetPaymentSessionCommand,
  ProcessPaymentCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, formatEther, http, type PublicClient } from "viem";
import { assertNoMainnetConfig } from "../../src/guard/network.js";
import { redact } from "../../src/guard/redact.js";
import { PayToAllowlist } from "../../src/guard/payToAllowlist.js";
import { permit2Allowance, permit2Approvals, shrinkAllowance } from "./allowance.js";

const MODE = process.argv.find((a) => a.startsWith("--mode="))?.slice(7) ?? "harness-local";
const N = Number(process.argv.find((a) => a.startsWith("--n="))?.slice(4) ?? 20);
const OUT_DIR = resolve(process.env["AC3_OUT_DIR"] ?? "artifacts/ac3");
const REGION = process.env["AWS_REGION"] ?? "us-east-1";
const FACILITATOR = process.env["AC3_FACILITATOR"] ?? "https://x402.org/facilitator";
// セッション上限（$0.20）と同じ 0.20 USDC。試験の最後に 1 まで縮める（shrinkAllowance）
const PERMIT2_LIMIT = process.env["AGENTCORE_PERMIT2_ALLOWANCE_LIMIT"] ?? "200000";
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

function write(name: string, data: unknown): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, `${name}.json`), `${JSON.stringify(redact(data), null, 2)}\n`, "utf8");
}

/** 模擬売り手をこのスクリプト専用のポートで立てる（既存の 8402 とは別）。 */
async function startMock(port: number, env: Record<string, string>): Promise<ChildProcess> {
  // npx を挟むと kill が孫プロセスに届かずポートが残るので、node に tsx を読ませて直接起動する
  const child = spawn(process.execPath, ["--import", "tsx", "mock/server.ts"], {
    env: { ...process.env, MOCK_PORT: String(port), ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  child.stderr!.on("data", (d) => (log += String(d)));
  (child as ChildProcess & { log: () => string }).log = () => log;
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false);
    if (ok) return child;
  }
  child.kill();
  throw new Error(`模擬売り手が ${port} で起動しない: ${log.slice(-300)}`);
}

function stopMock(child: ChildProcess): void {
  child.kill("SIGTERM");
}

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const c = spawn("npx", ["tsx", "src/cli.ts", ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += String(d)));
    c.stderr.on("data", (d) => (out += String(d)));
    c.on("close", (code) => res({ code: code ?? -1, out }));
  });
}

function events(dir: string): Array<Record<string, unknown>> {
  return readFileSync(resolve(dir, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---------------------------------------------------------------- harness-local
async function harnessLocal(): Promise<void> {
  const port = 8413;
  const mock = await startMock(port, {});
  try {
    const url = `http://127.0.0.1:${port}/x402/v2/upto`;
    const runId = "harness-local-run";
    const { code } = await runCli(
      [
        `--label=ac3-${runId}`,
        `--run-id=${runId}`,
        `--out=${OUT_DIR}`,
        "--rail=x402",
        "--approve=yes",
        `--endpoints=${Array.from({ length: N }, () => url).join(",")}`,
      ],
      { PER_CALL_MAX_USD: "0.05", SESSION_MAX_USD: "0.20" },
    );
    const ev = events(resolve(OUT_DIR, runId));
    const settled = ev.filter((e) => e["type"] === "guard.limit.settled");
    const declined = ev.filter((e) => e["type"] === "pay.declined");
    const firstDecline = ev.filter((e) => e["type"] === "tool.pay.call" || e["type"] === "pay.declined");
    let idx = 0;
    let firstDeclinedCall: number | null = null;
    for (const e of firstDecline) {
      if (e["type"] === "tool.pay.call") idx += 1;
      else if (firstDeclinedCall === null) firstDeclinedCall = idx;
    }
    write("harness-local", {
      mode: "harness-local",
      measuredAt: new Date().toISOString(),
      what: "自前ガード（層2）の upto 計上。AgentCore は使っていない（local-signer）",
      seller: url,
      cap_usd: "0.05",
      charge_usd: "0.01",
      session_max_usd: "0.20",
      calls_attempted: N,
      successful_payments: settled.length,
      first_declined_call: firstDeclinedCall,
      decline_rule: declined[0]?.["rule"] ?? null,
      spent_after_each: settled.map((e) => e["spent_usd"]),
      released_each_atomic: settled.map((e) => e["released_atomic"]),
      exit_code: code,
      events: `artifacts/ac3/${runId}/events.jsonl`,
      reading:
        "上限額で予約し、settle の実額で確定・差額を解放する。次の呼び出しは「使用済み＋上限額 ≤ セッション上限」を要求するので、" +
        "実額 $0.01 × k + 上限 $0.05 ≤ $0.20 となる k=15 回目までの次、つまり 16 回目まで通り 17 回目で止まる。",
    });
    process.stdout.write(`harness-local: ${settled.length} 回成功、最初の拒否は ${firstDeclinedCall} 回目\n`);
  } finally {
    stopMock(mock);
  }
}

// ---------------------------------------------------------------- facilitator-probe
async function facilitatorProbe(): Promise<void> {
  const port = 8414;
  const supported = (await fetch(`${FACILITATOR}/supported`).then((r) => r.json())) as {
    kinds: Array<{ x402Version: number; scheme: string; network: string; extra?: { facilitatorAddress?: string } }>;
  };
  const kind = supported.kinds.find((k) => k.scheme === "upto" && k.network === "eip155:84532");
  const mock = await startMock(port, {
    MOCK_UPTO_FACILITATOR: FACILITATOR,
    ...(kind?.extra?.facilitatorAddress ? { MOCK_UPTO_FACILITATOR_ADDRESS: kind.extra.facilitatorAddress } : {}),
  });
  try {
    const url = `http://127.0.0.1:${port}/x402/v2/upto`;
    const runId = "facilitator-probe-run";
    const { code } = await runCli(
      [`--label=ac3-${runId}`, `--run-id=${runId}`, `--out=${OUT_DIR}`, "--rail=x402", "--approve=yes", `--endpoint=${url}`],
      {},
    );
    const ev = events(resolve(OUT_DIR, runId));
    const resend = ev.find((e) => e["type"] === "http.response" && e["phase"] === "x402.retry-with-payment");
    const mockLog = (mock as ChildProcess & { log: () => string }).log();
    write("facilitator-probe", {
      mode: "facilitator-probe",
      measuredAt: new Date().toISOString(),
      facilitator: FACILITATOR,
      supported_upto_base_sepolia: kind ?? null,
      what:
        "local-signer（残高ゼロ・Permit2 未 approve の使い捨て鍵）で upto に署名し、模擬売り手経由で facilitator の /verify に投げた。" +
        "facilitator が upto を受け付ける経路であることと、断る理由を記録する。",
      signature_generated: ev.some((e) => e["type"] === "localsigner.proof.generated" && e["scheme"] === "upto"),
      resend_status: resend?.["status"] ?? null,
      resend_body: resend?.["body"] ?? null,
      facilitator_calls_from_mock: mockLog
        .split("\n")
        .filter((l) => l.includes("facilitator /"))
        .map((l) => l.replace(/^\[mock-merchant\] /, "").slice(0, 400)),
      exit_code: code,
      events: `artifacts/ac3/${runId}/events.jsonl`,
    });
    process.stdout.write(`facilitator-probe: resend=${String(resend?.["status"])}\n`);
  } finally {
    stopMock(mock);
  }
}

// ---------------------------------------------------------------- live
async function live(): Promise<void> {
  const managerArn = process.env["AGENTCORE_PAYMENT_MANAGER_ARN"];
  const instrumentId = process.env["AGENTCORE_PAYMENT_INSTRUMENT_ID"];
  const userId = process.env["PAYMENT_USER_EMAIL"];
  const wallet = process.env["AGENTCORE_WALLET_ADDRESS"] as `0x${string}` | undefined;
  if (!managerArn || !instrumentId || !userId) {
    write("live", {
      mode: "live",
      executed: false,
      reason: "資格情報／provision の出力が無い: AGENTCORE_PAYMENT_MANAGER_ARN / AGENTCORE_PAYMENT_INSTRUMENT_ID / PAYMENT_USER_EMAIL",
    });
    process.stdout.write("live: 資格情報が無いので未実施として記録\n");
    return;
  }
  const port = 8415;
  const mock = await startMock(port, { MOCK_UPTO_FACILITATOR: FACILITATOR });
  const plane = new BedrockAgentCoreClient({ region: REGION, maxAttempts: 1 });
  // chain 定義を渡すと OP Stack の型が PublicClient と合わないので、RPC の URL だけで作る
  const chain: PublicClient = createPublicClient({ transport: http(process.env["BASE_SEPOLIA_RPC"] ?? "https://sepolia.base.org") });
  const eth = async (): Promise<string | null> => (wallet ? formatEther(await chain.getBalance({ address: wallet })) : null);
  const allowance = async (): Promise<string | null> => (wallet ? permit2Allowance(chain, USDC_BASE_SEPOLIA, wallet) : null);

  const openSession = async (maxUsd: string): Promise<string> => {
    const r = await plane.send(
      new CreatePaymentSessionCommand({
        paymentManagerArn: managerArn,
        userId,
        agentName: "ac3-runner",
        limits: { maxSpendAmount: { value: maxUsd, currency: "USD" } },
        expiryTimeInMinutes: 30,
        clientToken: randomUUID(),
      }),
    );
    return r.paymentSession!.paymentSessionId!;
  };
  const budgetOf = async (sid: string): Promise<string | null> => {
    const r = await plane.send(new GetPaymentSessionCommand({ paymentManagerArn: managerArn, paymentSessionId: sid, userId }));
    const a = r.paymentSession?.availableLimits?.availableSpendAmount;
    return a ? `${a.value} ${a.currency}` : null;
  };
  const closeSession = (sid: string) =>
    plane.send(new DeletePaymentSessionCommand({ paymentManagerArn: managerArn, paymentSessionId: sid, userId })).catch(() => undefined);

  const url = `http://127.0.0.1:${port}/x402/v2/upto`;
  const calls: Array<Record<string, unknown>> = [];
  let firstRejected: number | null = null;
  const startBlock = await chain.getBlockNumber();
  const allowanceBeforeTest = await allowance();
  let allowanceAfterTest: string | null = null;
  let shrink: Record<string, unknown> | null = null;
  const sessionId = await openSession("0.20");
  const budget = () => budgetOf(sessionId);
  try {
    for (let i = 1; i <= N; i++) {
      const r402 = await fetch(url);
      const required = JSON.parse(Buffer.from(r402.headers.get("payment-required")!, "base64").toString("utf8"));
      const accept = required.accepts[0];
      const withPermit2 = i === 1;
      const rec: Record<string, unknown> = { i, permit2AllowanceLimit: withPermit2 ? PERMIT2_LIMIT : null };
      rec["budget_before"] = await budget();
      rec["eth_before"] = withPermit2 ? await eth() : undefined;
      try {
        const res = await plane.send(
          new ProcessPaymentCommand({
            paymentManagerArn: managerArn,
            paymentSessionId: sessionId,
            paymentInstrumentId: instrumentId,
            userId,
            agentName: "ac3-runner",
            paymentType: "CRYPTO_X402",
            paymentInput: {
              cryptoX402: {
                version: "2",
                payload: accept,
                ...(withPermit2 ? { permit2AllowanceLimit: PERMIT2_LIMIT } : {}),
              },
            },
            clientToken: randomUUID(),
          }),
        );
        rec["processPaymentId"] = res.processPaymentId;
        rec["status"] = res.status;
        rec["budget_after_proof"] = await budget();
        if (withPermit2) rec["eth_after_approve"] = await eth();
        const header = Buffer.from(
          JSON.stringify({
            x402Version: 2,
            resource: required.resource,
            accepted: accept,
            extensions: required.extensions ?? {},
            payload: res.paymentOutput?.cryptoX402?.payload,
          }),
        ).toString("base64");
        const r200 = await fetch(url, { headers: { "PAYMENT-SIGNATURE": header } });
        const pr = r200.headers.get("payment-response");
        rec["resend_status"] = r200.status;
        rec["settlement"] = pr ? JSON.parse(Buffer.from(pr, "base64").toString("utf8")) : (await r200.text()).slice(0, 300);
        await new Promise((r) => setTimeout(r, 5000));
        rec["budget_after_settle_5s"] = await budget();
      } catch (e) {
        const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
        rec["error"] = { name: err.name, message: err.message, httpStatus: err.$metadata?.httpStatusCode };
        rec["budget_after"] = await budget().catch(() => null);
        firstRejected ??= i;
      }
      calls.push(rec);
      process.stdout.write(`live ${i}: ${JSON.stringify(rec).slice(0, 220)}\n`);
      if (rec["error"]) break;
    }
  } finally {
    await closeSession(sessionId);
    allowanceAfterTest = await allowance().catch(() => null);
    // 試験が途中で止まっても、承認を出した可能性があれば必ず縮める（testnet は自動）
    if (calls.length > 0) {
      shrink = await shrinkAllowance({
        plane,
        chain,
        managerArn,
        instrumentId,
        userId,
        wallet,
        usdc: USDC_BASE_SEPOLIA,
        payTo: PayToAllowlist.load(),
        fresh402: async () => {
          const r = await fetch(url);
          return JSON.parse(Buffer.from(r.headers.get("payment-required")!, "base64").toString("utf8"));
        },
        openSession,
        budgetOf,
        closeSession,
      }).catch((e) => ({ executed: false, error: (e as Error).message }));
    }
    stopMock(mock);
  }

  const approvals = wallet ? await permit2Approvals(chain, USDC_BASE_SEPOLIA, wallet, startBlock).catch(() => []) : [];
  const first = calls[0] ?? {};
  const firstApproval = approvals.find((a) => a.value === PERMIT2_LIMIT) ?? null;
  const gasEthByBalance =
    first["eth_before"] && first["eth_after_approve"]
      ? (Number(first["eth_before"]) - Number(first["eth_after_approve"])).toFixed(12)
      : null;
  const processPaymentCalls = calls.filter((c) => c["processPaymentId"] || c["error"]).length;
  write("live", {
    mode: "live",
    executed: true,
    measuredAt: new Date().toISOString(),
    region: REGION,
    facilitator: FACILITATOR,
    seller: "mock-local /x402/v2/upto（settle は facilitator が Base Sepolia で実行）",
    cap_usd: "0.05",
    charge_usd: "0.01",
    session_max_usd: "0.20",
    permit2AllowanceLimit_first_call_only: PERMIT2_LIMIT,
    first_rejected_call: firstRejected,
    successful_calls: calls.filter((c) => !c["error"]).length,
    approve_tx: firstApproval,
    approve_gas_eth: firstApproval?.gasCostEth ?? gasEthByBalance,
    approve_gas_note: !wallet
      ? "AGENTCORE_WALLET_ADDRESS が無いので測っていない"
      : firstApproval
        ? "USDC の Approval イベント（owner=wallet, spender=Permit2）から引いた tx の gasUsed × effectiveGasPrice"
        : "Approval イベントが見つからないので、初回前後の ETH 残高差",
    allowance_permit2: {
      unit: "USDC の最小単位（6 decimals）",
      before_test: allowanceBeforeTest,
      after_test: allowanceAfterTest,
      after_shrink: (shrink?.["allowance_after"] as string | undefined) ?? null,
    },
    shrink,
    wallet_operations: {
      test_process_payment: processPaymentCalls,
      shrink_process_payment: shrink?.["executed"] ? 1 : 0,
      fee_per_operation_usd: "0.005",
      note: "Coinbase では ProcessPayment 1 回 = wallet operation 1 回（AgentCore 料金ページ）。provision 時の CreatePaymentInstrument 1 回は含めない",
    },
    calls,
  });
}

async function main(): Promise<number> {
  assertNoMainnetConfig();
  if (MODE === "harness-local") await harnessLocal();
  else if (MODE === "facilitator-probe") await facilitatorProbe();
  else if (MODE === "live") await live();
  else throw new Error(`--mode=${MODE} は不正`);
  return 0;
}

main().then((c) => process.exit(c));

/**
 * AC-3c: Base mainnet の upto で、AgentCore のセッション予算が「上限額」と「実額」のどちらで減るかを測る。
 *
 * AC-3b（2s）は 3 回とも上限額いっぱいで請求され、区別できなかった。ここでは売り手の役を自分でやる:
 *   - 402 の要求を自分で組む（upto / eip155:8453 / USDC / payTo = 自分のウォレット）
 *   - ProcessPayment で署名を受け取り、Coinbase CDP の facilitator に /verify（上限額）と /settle（実額）を投げる
 *   - 支払い先は自分のウォレットなので USDC は外に出ない（出るのは approve の gas と AgentCore のウォレット操作の手数料）
 *
 * 上限 $0.0025 / 実額 $0.0005 / セッション上限 $0.01 で繰り返し、何回目で拒否されるかを見る。
 *   4 回で止まる  → 上限額で減っている
 *   16 回で止まる → 実額で計上しつつ、次の呼び出しの上限額ぶんの空きを要求している
 *   20 回で止まる → 実額で減っている
 * 各回の前後・署名後・settle 5 秒後に GetPaymentSession の残予算を取る。
 * 最後に承認を 1 に縮める（upto・署名額 1・permit2AllowanceLimit "1"。settle しない）。
 *
 * ガード: --allow-mainnet が無ければ署名しない。payTo は allowlist の seller=self のエントリだけ。
 * 支払い署名（payload / signature / permit2Authorization）は記録しない。
 * 出力: artifacts/ac3/ac3c-mainnet-self.json
 */
import {
  BedrockAgentCoreClient,
  CreatePaymentSessionCommand,
  DeletePaymentSessionCommand,
  GetPaymentSessionCommand,
  ProcessPaymentCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { createFacilitatorConfig } from "@coinbase/x402";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, formatEther, http, type PublicClient } from "viem";
import { redact } from "../../src/guard/redact.js";
import { PayToAllowlist, type PayToEntry } from "../../src/guard/payToAllowlist.js";
import { permit2Allowance, permit2Approvals } from "./allowance.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const NETWORK = "eip155:8453";
const CAP = process.env["AC3C_CAP"] ?? "2500"; // $0.0025（CDP facilitator は 500 を amount_too_low で拒否。2500 は 2s で通った）
const CHARGE = process.env["AC3C_CHARGE"] ?? "500"; // $0.0005
const SESSION_USD = process.env["AC3C_SESSION_USD"] ?? "0.01";
const N = Number(process.argv.find((a) => a.startsWith("--n="))?.slice(4) ?? 22);
const PERMIT2_LIMIT = String(Number(CHARGE) * N); // 実額の合計まで。最後に 1 へ縮める
const REGION = process.env["AWS_REGION"] ?? "ap-southeast-2";
const RPC = process.env["BASE_PUBLIC_RPC"] ?? "https://base-rpc.publicnode.com";
const OUT = resolve("artifacts/ac3/ac3c-mainnet-self.json");
const LEDGER = resolve("artifacts/ac3/mainnet-ledger.json");
const TOTAL_CAP = 1.0;

function ledgerAdd(usd: number, tx: string): void {
  const d = JSON.parse(readFileSync(LEDGER, "utf8")) as { total_usd: string; entries: unknown[] };
  if (Number(d.total_usd) + usd > TOTAL_CAP) throw new Error("total cap");
  d.entries.push({ at: new Date().toISOString().slice(0, 19) + "Z", seller: "self", usd: String(usd), tx });
  d.total_usd = String(Math.round((Number(d.total_usd) + usd) * 1e6) / 1e6);
  writeFileSync(LEDGER, `${JSON.stringify(d, null, 2)}\n`);
}

/** facilitator の応答から署名らしいものを落とす（settle 応答には署名は無いが念のため） */
const clean = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !/signature|payload|authorization/i.test(k)));

async function main(): Promise<number> {
  const allowMainnet = process.argv.includes("--allow-mainnet");
  const managerArn = process.env["AGENTCORE_PAYMENT_MANAGER_ARN"]!;
  const instrumentId = process.env["AGENTCORE_PAYMENT_INSTRUMENT_ID"]!;
  const userId = process.env["PAYMENT_USER_EMAIL"]!;
  const wallet = process.env["AGENTCORE_WALLET_ADDRESS"] as `0x${string}`;
  if (!managerArn || !instrumentId || !userId || !wallet) throw new Error("AGENTCORE_* / PAYMENT_USER_EMAIL / AGENTCORE_WALLET_ADDRESS が要る");

  const fac = createFacilitatorConfig(process.env["CDP_API_KEY_ID"], process.env["CDP_API_KEY_SECRET"]);
  const headers = async (op: "verify" | "settle" | "supported"): Promise<Record<string, string>> =>
    ((await fac.createAuthHeaders!()) as Record<string, Record<string, string>>)[op]!;
  const sup = (await (await fetch(`${fac.url}/supported`, { headers: await headers("supported") })).json()) as {
    kinds: Array<{ scheme: string; network: string; extra?: { facilitatorAddress?: string } }>;
  };
  const kind = sup.kinds.find((k) => k.scheme === "upto" && k.network === NETWORK);
  if (!kind?.extra?.facilitatorAddress) throw new Error("CDP facilitator が Base mainnet の upto を返さない");

  const accept = (amount: string) => ({
    scheme: "upto",
    network: NETWORK,
    amount,
    asset: USDC,
    payTo: wallet,
    maxTimeoutSeconds: 360,
    extra: { name: "USD Coin", version: "2", facilitatorAddress: kind.extra!.facilitatorAddress! },
  });
  const resource = { url: "urn:ac3c:self-seller", description: "AC-3c self seller (upto budget measurement)", mimeType: "application/json" };

  // payTo ガード: seller=self のエントリだけ
  const entries = (JSON.parse(readFileSync("config/payto-allowlist.mainnet.json", "utf8")) as { entries: Array<PayToEntry & { seller: string }> }).entries;
  const guard = new PayToAllowlist(entries.filter((e) => e.seller === "self"));
  const verdict = guard.check({ payTo: wallet, network: NETWORK });
  const record: Record<string, unknown> = {
    measuredAt: new Date().toISOString(),
    seller: "self（402 を自分で組み、Coinbase CDP facilitator で settle。payTo = 自分のウォレット）",
    facilitator: fac.url,
    facilitatorAddress: kind.extra.facilitatorAddress,
    cap_atomic: CAP,
    charge_atomic: CHARGE,
    session_max_usd: SESSION_USD,
    permit2AllowanceLimit_first_call_only: PERMIT2_LIMIT,
    payto_guard: "reason" in verdict ? verdict.reason : "allowed (seller=self)",
    guards: { allow_mainnet: allowMainnet },
  };
  if (!allowMainnet || !verdict.allowed) {
    record["executed"] = false;
    record["reason"] = !allowMainnet ? "--allow-mainnet が無い（署名していない）" : `payTo ガードで拒否: ${"reason" in verdict ? verdict.reason : ""}`;
    writeFileSync(OUT, `${JSON.stringify(redact(record), null, 2)}\n`);
    console.log(record["reason"]);
    return 0;
  }

  const plane = new BedrockAgentCoreClient({ region: REGION, maxAttempts: 1 });
  const chain: PublicClient = createPublicClient({ transport: http(RPC) });
  const openSession = async (maxUsd: string): Promise<string> =>
    (
      await plane.send(
        new CreatePaymentSessionCommand({
          paymentManagerArn: managerArn,
          userId,
          agentName: "ac3c-self",
          limits: { maxSpendAmount: { value: maxUsd, currency: "USD" } },
          expiryTimeInMinutes: 30,
          clientToken: randomUUID(),
        }),
      )
    ).paymentSession!.paymentSessionId!;
  const budgetOf = async (sid: string): Promise<string | null> => {
    const a = (await plane.send(new GetPaymentSessionCommand({ paymentManagerArn: managerArn, paymentSessionId: sid, userId }))).paymentSession
      ?.availableLimits?.availableSpendAmount;
    return a ? `${a.value} ${a.currency}` : null;
  };
  const closeSession = (sid: string) =>
    plane.send(new DeletePaymentSessionCommand({ paymentManagerArn: managerArn, paymentSessionId: sid, userId })).catch(() => undefined);
  const sign = async (sid: string, amount: string, permit2?: string) =>
    plane.send(
      new ProcessPaymentCommand({
        paymentManagerArn: managerArn,
        paymentSessionId: sid,
        paymentInstrumentId: instrumentId,
        userId,
        agentName: "ac3c-self",
        paymentType: "CRYPTO_X402",
        paymentInput: { cryptoX402: { version: "2", payload: accept(amount), ...(permit2 ? { permit2AllowanceLimit: permit2 } : {}) } },
        clientToken: randomUUID(),
      }),
    );
  const facCall = async (op: "verify" | "settle", payload: unknown, amount: string): Promise<Record<string, unknown>> => {
    const resp = await fetch(`${fac.url}/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await headers(op)) },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: { x402Version: 2, resource, accepted: accept(CAP), payload },
        paymentRequirements: accept(amount),
      }),
    });
    const text = await resp.text();
    try {
      return { httpStatus: resp.status, ...clean(JSON.parse(text) as Record<string, unknown>) };
    } catch {
      return { httpStatus: resp.status, raw: text.slice(0, 300) };
    }
  };

  const startBlock = (await chain.getBlockNumber()) - 5n;
  const allowanceBefore = await permit2Allowance(chain, USDC, wallet);
  const ethBefore = formatEther(await chain.getBalance({ address: wallet }));
  const calls: Array<Record<string, unknown>> = [];
  let firstRejected: number | null = null;
  const sid = await openSession(SESSION_USD);
  try {
    for (let i = 1; i <= N; i++) {
      const rec: Record<string, unknown> = { i, permit2AllowanceLimit: i === 1 ? PERMIT2_LIMIT : null };
      rec["budget_before"] = await budgetOf(sid);
      try {
        const res = await sign(sid, CAP, i === 1 ? PERMIT2_LIMIT : undefined);
        rec["processPaymentId"] = res.processPaymentId;
        rec["status"] = res.status;
        rec["budget_after_proof"] = await budgetOf(sid);
        const payload = res.paymentOutput?.cryptoX402?.payload;
        const v = await facCall("verify", payload, CAP);
        rec["verify"] = v;
        if (v["isValid"] !== true) {
          rec["error"] = { name: "facilitator_verify_failed" };
        } else {
          const st = await facCall("settle", payload, CHARGE);
          rec["settle"] = st;
          if (st["success"] === true) ledgerAdd(Number(CHARGE) / 1e6, String(st["transaction"] ?? ""));
          else rec["error"] = { name: "facilitator_settle_failed" };
        }
        await new Promise((r) => setTimeout(r, 5000));
        rec["budget_after_settle_5s"] = await budgetOf(sid);
      } catch (e) {
        const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
        rec["error"] = { name: err.name, message: err.message, httpStatus: err.$metadata?.httpStatusCode };
        rec["budget_after"] = await budgetOf(sid).catch(() => null);
        firstRejected ??= i;
      }
      calls.push(rec);
      console.log(`call ${i}: ${rec["budget_before"]} -> proof ${rec["budget_after_proof"] ?? "-"} -> settle5s ${rec["budget_after_settle_5s"] ?? "-"} ${rec["error"] ? JSON.stringify(rec["error"]).slice(0, 200) : `settled ${String((rec["settle"] as Record<string, unknown>)?.["amount"] ?? "")}`}`);
      if (rec["error"]) break;
    }
  } finally {
    await closeSession(sid);
  }

  const allowanceAfterTest = await permit2Allowance(chain, USDC, wallet);
  // 承認を 1 に縮める（settle しない）
  let shrink: Record<string, unknown>;
  const ssid = await openSession("0.01");
  try {
    const b0 = await budgetOf(ssid);
    const r = await sign(ssid, "1", "1");
    shrink = { executed: true, processPaymentId: r.processPaymentId, status: r.status, budget_before: b0, budget_after: await budgetOf(ssid) };
  } catch (e) {
    shrink = { executed: false, error: (e as Error).message };
  } finally {
    await closeSession(ssid);
  }
  let allowanceAfterShrink = await permit2Allowance(chain, USDC, wallet);
  for (let t = 0; t < 30 && allowanceAfterShrink !== "1"; t++) {
    await new Promise((r) => setTimeout(r, 3000));
    allowanceAfterShrink = await permit2Allowance(chain, USDC, wallet);
  }
  const approvals = await permit2Approvals(chain, USDC, wallet, startBlock).catch(() => []);
  const firstApproval = approvals.find((a) => a.value === PERMIT2_LIMIT) ?? null;
  const shrinkApproval = approvals.find((a) => a.value === "1") ?? null;
  shrink = { ...shrink, approve_tx: shrinkApproval, approve_gas_eth: shrinkApproval?.gasCostEth ?? null, allowance_after: allowanceAfterShrink, allowance_is_1: allowanceAfterShrink === "1" };

  const ok = calls.filter((c) => !c["error"]).length;
  const facFailed = calls.some((c) => c["error"] && (c["error"] as Record<string, unknown>)["name"]?.toString().startsWith("facilitator_"));
  const verdictText = facFailed
    ? "未判定（facilitator が verify / settle を断った。AgentCore の拒否ではない）"
    : firstRejected === null
      ? `${N} 回すべて通った（拒否まで届かず）`
      : firstRejected <= 5
        ? "上限額で減っている"
        : firstRejected <= 17
          ? "実額で計上しつつ、次の上限額ぶんの空きを要求している"
          : "実額で減っている";
  Object.assign(record, {
    executed: true,
    successful_calls: ok,
    first_rejected_call: firstRejected,
    verdict: verdictText,
    approve_tx: firstApproval,
    approve_gas_eth: firstApproval?.gasCostEth ?? null,
    eth: { before: ethBefore, after: formatEther(await chain.getBalance({ address: wallet })) },
    allowance_permit2: { unit: "USDC の最小単位（6 decimals）", before_test: allowanceBefore, after_test: allowanceAfterTest, after_shrink: allowanceAfterShrink },
    shrink,
    wallet_operations: { test_process_payment: calls.filter((c) => c["processPaymentId"] || c["error"]).length, shrink_process_payment: shrink["executed"] ? 1 : 0, fee_per_operation_usd: "0.005" },
    calls,
  });
  mkdirSync(resolve("artifacts/ac3"), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(redact(record), null, 2)}\n`);
  console.log(JSON.stringify({ successful_calls: ok, first_rejected_call: firstRejected, verdict: verdictText, allowance: record["allowance_permit2"] }));
  return 0;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);

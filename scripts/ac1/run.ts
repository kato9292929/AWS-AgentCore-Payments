/**
 * AC-1: ProcessPayment の冪等性と、支払いを止める条件の実測。
 *
 * ProcessPayment を AWS SDK で直接呼ぶ（ハーネスの自前ガードを通らない＝AgentCore 側だけの挙動）。
 * 402 のペイロードはローカル模擬売り手（mock/server.ts）から取る。売り手への再送はしない
 * （EIP-3009 / Permit2 の署名は残高が無くても生成できるはず。生成できなければその事実を残す）。
 *
 * 各ケースは artifacts/ac1/<case>.json に
 *   ProcessPayment の入力・出力・processPaymentId・status・呼ぶ前後のセッション残予算
 * をすべて残す。残予算は GetPaymentSession の availableLimits.availableSpendAmount。
 *
 *   D1 同じ 402・同じ clientToken で 2 回
 *   D2 同じ 402・別の clientToken で 2 回
 *   D3 → scripts/ac1/d3_client_token.py（Strands プラグインと generate_payment_header の 2 経路）
 *   D4 セッション上限 $0.20 に $0.05 を 5 回（x402 v1、network は slug "base-sepolia"）
 *   D4h D4 をハーネス経由で --guards=agentcore-only にして回す（自前ガードを外したとき AgentCore だけで止まるか）
 *   D5 セッションの有効期限切れの後に呼ぶ（最短 15 分。--cases=D5 を明示したときだけ待つ）
 *   D6 MPP: 期限切れのチャレンジ
 *   D7 MPP: feePayer=false で buyerPaysGasFees を渡さない（対照: feePayer=true）
 *   D8 D4 を x402 v2・CAIP-2（eip155:84532）で
 *
 * 使い方:
 *   npm run mock:merchant      # 別ターミナル
 *   AWS_REGION=us-east-1 AGENTCORE_PAYMENT_MANAGER_ARN=... AGENTCORE_PAYMENT_INSTRUMENT_ID=... \
 *   PAYMENT_USER_EMAIL=... npm run ac1 -- [--cases=D1,D2,D4,D4h,D6,D7,D8] [--cases=D5]
 *
 * 資格情報が無い／無効なときは、各ケースに executed:false と理由、送るはずだった入力を残して終わる。
 */
import {
  BedrockAgentCoreClient,
  CreatePaymentSessionCommand,
  DeletePaymentSessionCommand,
  GetPaymentSessionCommand,
  ListPaymentSessionsCommand,
  ProcessPaymentCommand,
  type ProcessPaymentCommandInput,
} from "@aws-sdk/client-bedrock-agentcore";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertNoMainnetConfig } from "../../src/guard/network.js";
import { redact } from "../../src/guard/redact.js";

const MOCK = process.env["MOCK_BASE_URL"] ?? "http://127.0.0.1:8402";
const OUT_DIR = resolve(process.env["AC1_OUT_DIR"] ?? "artifacts/ac1");
const REGION = process.env["AWS_REGION"] ?? "us-east-1";
const SESSION_MAX_USD = "0.20";

const argCases = process.argv
  .filter((a) => a.startsWith("--cases="))
  .flatMap((a) => a.slice(8).split(","))
  .filter(Boolean);
const CASES = argCases.length > 0 ? argCases : ["D1", "D2", "D4", "D4h", "D6", "D7", "D8"];

// ---------------- 402 の取得 ----------------

interface Fetched402 {
  url: string;
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

async function get402(path: string): Promise<Fetched402> {
  const url = `${MOCK}${path}`;
  const res = await fetch(url, { headers: { "Accept-Payment": "evm/charge" } });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return { url, status: res.status, headers, bodyText: await res.text() };
}

/** x402 の accept 1 件（v1 body / v2 ヘッダ）と version。 */
function x402Accept(f: Fetched402): { version: number; accept: Record<string, unknown> } {
  const h = f.headers["payment-required"];
  const body = h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : JSON.parse(f.bodyText);
  return { version: Number(body.x402Version), accept: body.accepts[0] };
}

function x402Input(f: Fetched402): ProcessPaymentCommandInput["paymentInput"] {
  const { version, accept } = x402Accept(f);
  // bedrock-agentcore 1.24.2 の generate_payment_header と同じく、選んだ accept を verbatim で渡す
  return { cryptoX402: { version: String(version), payload: accept as never } };
}

function mppInput(f: Fetched402, buyerPaysGasFees?: boolean): ProcessPaymentCommandInput["paymentInput"] {
  const www = f.headers["www-authenticate"];
  if (!www) throw new Error(`${f.url} が WWW-Authenticate を返さなかった`);
  return {
    mpp: {
      version: "1",
      wwwAuthenticateHeaders: [www],
      ...(buyerPaysGasFees !== undefined ? { buyerPaysGasFees } : {}),
    },
  };
}

// ---------------- AgentCore 呼び出しと記録 ----------------

interface CallRecord {
  label: string;
  clientToken: string;
  input: unknown;
  ok: boolean;
  latencyMs: number;
  output?: {
    processPaymentId?: string;
    status?: string;
    paymentType?: string;
    /** 証明の中身は形だけ残す（署名そのものは鍵ではないが、長さとキーで十分） */
    paymentOutputShape?: unknown;
    createdAt?: string;
  };
  error?: { name?: string; message?: string; httpStatus?: number; fault?: string };
  budgetBefore: string | null;
  budgetAfter: string | null;
}

interface CaseRecord {
  case: string;
  question: string;
  executed: boolean;
  reason?: string;
  startedAt: string;
  finishedAt?: string;
  region: string;
  paymentSessionId?: string;
  sessionMaxUsd?: string;
  seller: string[];
  calls: CallRecord[];
  /** 送るはずだった入力（未実施時の検証用） */
  plannedInputs?: unknown[];
  findings: Record<string, unknown>;
  notes?: string[];
}

type Plane = Pick<BedrockAgentCoreClient, "send">;

class Ctx {
  constructor(
    readonly plane: Plane,
    readonly managerArn: string,
    readonly instrumentId: string,
    readonly userId: string,
  ) {}

  async openSession(maxUsd = SESSION_MAX_USD, expiryMinutes = 15): Promise<string> {
    const res = await this.plane.send(
      new CreatePaymentSessionCommand({
        paymentManagerArn: this.managerArn,
        userId: this.userId,
        agentName: "ac1-runner",
        limits: { maxSpendAmount: { value: maxUsd, currency: "USD" } },
        expiryTimeInMinutes: expiryMinutes,
        clientToken: randomUUID(),
      }),
    );
    const id = res.paymentSession?.paymentSessionId;
    if (!id) throw new Error("CreatePaymentSession が paymentSessionId を返さなかった");
    return id;
  }

  async budget(sessionId: string): Promise<string | null> {
    try {
      const res = await this.plane.send(
        new GetPaymentSessionCommand({
          paymentManagerArn: this.managerArn,
          paymentSessionId: sessionId,
          userId: this.userId,
        }),
      );
      const a = res.paymentSession?.availableLimits?.availableSpendAmount;
      return a ? `${a.value} ${a.currency}` : null;
    } catch (e) {
      return `error:${(e as Error).name}`;
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.plane
      .send(
        new DeletePaymentSessionCommand({
          paymentManagerArn: this.managerArn,
          paymentSessionId: sessionId,
          userId: this.userId,
        }),
      )
      .catch(() => undefined);
  }

  async pay(
    label: string,
    sessionId: string,
    paymentType: "CRYPTO_X402" | "MPP",
    paymentInput: ProcessPaymentCommandInput["paymentInput"],
    clientToken = randomUUID(),
  ): Promise<CallRecord> {
    const budgetBefore = await this.budget(sessionId);
    const input = {
      paymentManagerArn: this.managerArn,
      paymentSessionId: sessionId,
      paymentInstrumentId: this.instrumentId,
      userId: this.userId,
      agentName: "ac1-runner",
      paymentType,
      paymentInput,
      clientToken,
    };
    const started = Date.now();
    try {
      const res = await this.plane.send(new ProcessPaymentCommand(input));
      const latencyMs = Date.now() - started;
      return {
        label,
        clientToken,
        input,
        ok: true,
        latencyMs,
        output: {
          processPaymentId: res.processPaymentId,
          status: res.status,
          paymentType: res.paymentType,
          paymentOutputShape: shapeOf(res.paymentOutput),
          createdAt: res.createdAt?.toISOString(),
        },
        budgetBefore,
        budgetAfter: await this.budget(sessionId),
      };
    } catch (e) {
      const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number }; $fault?: string };
      return {
        label,
        clientToken,
        input,
        ok: false,
        latencyMs: Date.now() - started,
        error: { name: err.name, message: err.message, httpStatus: err.$metadata?.httpStatusCode, fault: err.$fault },
        budgetBefore,
        budgetAfter: await this.budget(sessionId),
      };
    }
  }
}

/** 値は捨ててキーと型・長さだけ残す。 */
function shapeOf(v: unknown, depth = 0): unknown {
  if (depth > 5) return "…";
  if (Array.isArray(v)) return v.map((x) => shapeOf(x, depth + 1));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, shapeOf(x, depth + 1)]));
  }
  if (typeof v === "string") return v.length > 80 ? `<string len=${v.length}>` : v;
  return v;
}

// ---------------- ケース ----------------

const QUESTIONS: Record<string, string> = {
  D1: "同じ 402・同じ clientToken で 2 回: 2 回目が同じ processPaymentId を返すか、予算は 1 回分か",
  D2: "同じ 402・別の clientToken で 2 回: 2 回とも署名されるか、予算が 2 回分減るか",
  D4: "セッション上限 $0.20 に $0.05 を 5 回: 5 回目が拒否されるか、拒否時のエラー型",
  D4h: "D4 をハーネス経由・--guards=agentcore-only で: 自前ガードを外しても AgentCore 側だけで止まるか",
  D5: "セッションの有効期限切れの後に呼ぶ: 拒否されるか、エラー型",
  D6: "MPP: 期限切れのチャレンジ: ValidationException になり予算が減らないか",
  D7: "MPP: feePayer=false で buyerPaysGasFees を渡さない: ValidationException になるか",
  D8: "testnet（eip155:84532, x402 v2）で D4: セッション上限が testnet でも効くか",
};

const SELLER: Record<string, string[]> = {
  D1: ["/x402/weather"],
  D2: ["/x402/weather"],
  D4: ["/x402/nickel"],
  D4h: ["/x402/nickel"],
  D5: ["/x402/weather"],
  D6: ["/mpp/expired"],
  D7: ["/mpp/no-sponsor", "/mpp/sponsored"],
  D8: ["/x402/v2/nickel"],
};

function budgetDelta(c: CallRecord): string | null {
  const a = parseFloat(c.budgetBefore ?? "");
  const b = parseFloat(c.budgetAfter ?? "");
  return Number.isFinite(a) && Number.isFinite(b) ? (a - b).toFixed(6) : null;
}

async function runCase(ctx: Ctx, name: string, rec: CaseRecord): Promise<void> {
  const s = await ctx.openSession();
  rec.paymentSessionId = s;
  rec.sessionMaxUsd = SESSION_MAX_USD;
  try {
    switch (name) {
      case "D1": {
        const f = await get402("/x402/weather");
        const token = randomUUID();
        rec.calls.push(await ctx.pay("1st", s, "CRYPTO_X402", x402Input(f), token));
        rec.calls.push(await ctx.pay("2nd-same-token", s, "CRYPTO_X402", x402Input(f), token));
        const [a, b] = rec.calls;
        rec.findings = {
          same_processPaymentId: a?.output?.processPaymentId !== undefined && a.output.processPaymentId === b?.output?.processPaymentId,
          processPaymentIds: rec.calls.map((c) => c.output?.processPaymentId ?? null),
          second_call_error: b?.error ?? null,
          budget_delta_1st: a ? budgetDelta(a) : null,
          budget_delta_2nd: b ? budgetDelta(b) : null,
          budget_charged_once: a && b ? budgetDelta(b) === "0.000000" : null,
        };
        break;
      }
      case "D2": {
        const f = await get402("/x402/weather");
        rec.calls.push(await ctx.pay("1st", s, "CRYPTO_X402", x402Input(f)));
        rec.calls.push(await ctx.pay("2nd-new-token", s, "CRYPTO_X402", x402Input(f)));
        const [a, b] = rec.calls;
        rec.findings = {
          both_signed: rec.calls.every((c) => c.ok && c.output?.status !== undefined),
          processPaymentIds: rec.calls.map((c) => c.output?.processPaymentId ?? null),
          distinct_ids: a?.output?.processPaymentId !== b?.output?.processPaymentId,
          budget_delta_1st: a ? budgetDelta(a) : null,
          budget_delta_2nd: b ? budgetDelta(b) : null,
        };
        break;
      }
      case "D4":
      case "D8": {
        const f = await get402(name === "D4" ? "/x402/nickel" : "/x402/v2/nickel");
        for (let i = 1; i <= 5; i++) {
          rec.calls.push(await ctx.pay(`call-${i}`, s, "CRYPTO_X402", x402Input(f)));
        }
        const firstRejected = rec.calls.findIndex((c) => !c.ok);
        rec.findings = {
          network: x402Accept(f).accept["network"],
          x402Version: x402Accept(f).version,
          first_rejected_call: firstRejected === -1 ? null : firstRejected + 1,
          fifth_rejected: rec.calls[4] ? !rec.calls[4].ok : null,
          rejection_error: firstRejected === -1 ? null : rec.calls[firstRejected]?.error,
          budget_after_each: rec.calls.map((c) => c.budgetAfter),
        };
        break;
      }
      case "D5": {
        // 有効期限は API の最小値 15 分。切れるまで待ってから呼ぶ。
        const f = await get402("/x402/weather");
        const waitMs = Number(process.env["AC1_D5_WAIT_MS"] ?? 16 * 60_000);
        rec.notes = [`CreatePaymentSession(expiryTimeInMinutes=15) の後 ${waitMs}ms 待ってから ProcessPayment`];
        process.stdout.write(`  D5: ${Math.round(waitMs / 60000)} 分待つ…\n`);
        await new Promise((r) => setTimeout(r, waitMs));
        rec.calls.push(await ctx.pay("after-expiry", s, "CRYPTO_X402", x402Input(f)));
        const c = rec.calls[0];
        rec.findings = { rejected: c ? !c.ok : null, error: c?.error ?? null, budget_after: c?.budgetAfter ?? null };
        break;
      }
      case "D6": {
        const f = await get402("/mpp/expired");
        rec.calls.push(await ctx.pay("expired-challenge", s, "MPP", mppInput(f, false)));
        const c = rec.calls[0];
        rec.findings = {
          validation_exception: c?.error?.name === "ValidationException",
          error: c?.error ?? null,
          budget_unchanged: c ? budgetDelta(c) === "0.000000" : null,
        };
        break;
      }
      case "D7": {
        const noSponsor = await get402("/mpp/no-sponsor");
        const sponsored = await get402("/mpp/sponsored");
        rec.calls.push(await ctx.pay("feePayer=false, buyerPaysGasFees omitted", s, "MPP", mppInput(noSponsor)));
        rec.calls.push(await ctx.pay("feePayer=true (control)", s, "MPP", mppInput(sponsored)));
        const [a, b] = rec.calls;
        rec.findings = {
          validation_exception: a?.error?.name === "ValidationException",
          error: a?.error ?? null,
          budget_unchanged: a ? budgetDelta(a) === "0.000000" : null,
          control_ok: b?.ok ?? null,
          control_error: b?.error ?? null,
        };
        rec.notes = [
          "AWS docs では buyerPaysGasFees の同意が要るのは method=tempo。evm は facilitator がガスを払うので同意不要とされる。",
          "模擬売り手のチャレンジは method=evm なので、ValidationException にならないこと自体が docs どおりの可能性がある。",
        ];
        break;
      }
      default:
        throw new Error(`未知のケース ${name}`);
    }
  } finally {
    await ctx.closeSession(s);
  }
}

/** D4h: ハーネス（AgentCore backend）を --guards=agentcore-only で 5 回。 */
async function runD4h(rec: CaseRecord): Promise<void> {
  const runId = "ac1-D4h-harness";
  const url = `${MOCK}/x402/nickel`;
  const child = spawn(
    "npx",
    [
      "tsx",
      "src/cli.ts",
      `--label=${runId}`,
      `--run-id=${runId}`,
      "--out=artifacts/ac1",
      "--backend=agentcore",
      "--guards=agentcore-only",
      "--rail=x402",
      "--approve=yes",
      `--endpoints=${[url, url, url, url, url].join(",")}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PER_CALL_MAX_USD: "0.05", SESSION_MAX_USD } },
  );
  let out = "";
  child.stdout.on("data", (d) => (out += String(d)));
  child.stderr.on("data", (d) => (out += String(d)));
  const code: number = await new Promise((r) => child.on("close", (c) => r(c ?? -1)));
  const events = readFileSync(resolve("artifacts/ac1", runId, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const pays = events.filter((e) => e["type"] === "agentcore.process_payment.response" || e["type"] === "pay.error");
  rec.findings = {
    exit_code: code,
    harness_run: `artifacts/ac1/${runId}/events.jsonl`,
    harness_limit_enforced: events.find((e) => e["type"] === "guard.limit.decision")?.["enforced"] !== false,
    outcomes: pays.map((e) => (e["type"] === "pay.error" ? `error: ${String(e["error"]).slice(0, 160)}` : String(e["status"]))),
    first_error_index: (() => {
      const i = pays.findIndex((e) => e["type"] === "pay.error");
      return i === -1 ? null : i + 1;
    })(),
  };
  rec.notes = [out.trim().split("\n").slice(-3).join(" / ")];
}

function write(rec: CaseRecord): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, `${rec.case}.json`), `${JSON.stringify(redact(rec), null, 2)}\n`, "utf8");
}

async function preflight(): Promise<{ ok: true; ctx: Ctx } | { ok: false; reason: string }> {
  const managerArn = process.env["AGENTCORE_PAYMENT_MANAGER_ARN"];
  const instrumentId = process.env["AGENTCORE_PAYMENT_INSTRUMENT_ID"];
  const userId = process.env["PAYMENT_USER_EMAIL"] ?? process.env["USER_ID"];
  const missing = [
    ["AGENTCORE_PAYMENT_MANAGER_ARN", managerArn],
    ["AGENTCORE_PAYMENT_INSTRUMENT_ID", instrumentId],
    ["PAYMENT_USER_EMAIL", userId],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) return { ok: false, reason: `資格情報／provision の出力が無い: ${missing.join(", ")}` };
  const plane = new BedrockAgentCoreClient({ region: REGION, maxAttempts: 1 });
  try {
    await plane.send(new ListPaymentSessionsCommand({ paymentManagerArn: managerArn!, userId: userId!, maxResults: 1 }));
  } catch (e) {
    return { ok: false, reason: `AgentCore に届かない: ${(e as Error).name}: ${(e as Error).message}` };
  }
  return { ok: true, ctx: new Ctx(plane, managerArn!, instrumentId!, userId!) };
}

async function planned(name: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const p of SELLER[name] ?? []) {
    const f = await get402(p);
    out.push({
      seller: p,
      http_status: f.status,
      paymentType: p.startsWith("/mpp") ? "MPP" : "CRYPTO_X402",
      paymentInput: p.startsWith("/mpp") ? mppInput(f, name === "D7" ? undefined : false) : x402Input(f),
    });
  }
  return out;
}

async function main(): Promise<number> {
  assertNoMainnetConfig();
  const health = await fetch(`${MOCK}/health`).catch(() => null);
  if (!health?.ok) {
    process.stderr.write(`模擬売り手 ${MOCK} が動いていない（npm run mock:merchant）\n`);
    return 1;
  }
  const pf = await preflight();
  for (const name of CASES) {
    const rec: CaseRecord = {
      case: name,
      question: QUESTIONS[name] ?? name,
      executed: false,
      startedAt: new Date().toISOString(),
      region: REGION,
      seller: (SELLER[name] ?? []).map((p) => `${MOCK}${p}`),
      calls: [],
      findings: {},
    };
    if (!pf.ok) {
      rec.reason = pf.reason;
      rec.plannedInputs = await planned(name);
      write(rec);
      process.stdout.write(`SKIP ${name}  ${pf.reason}\n`);
      continue;
    }
    try {
      if (name === "D4h") await runD4h(rec);
      else await runCase(pf.ctx, name, rec);
      rec.executed = true;
    } catch (e) {
      rec.reason = `runner error: ${(e as Error).message}`;
    }
    rec.finishedAt = new Date().toISOString();
    write(rec);
    process.stdout.write(`${rec.executed ? "RAN " : "ERR "} ${name}  ${JSON.stringify(rec.findings).slice(0, 200)}\n`);
  }
  return 0;
}

main().then((c) => process.exit(c));

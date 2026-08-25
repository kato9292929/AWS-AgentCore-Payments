import { resolve } from "node:path";
import { AgentCoreBackend } from "./backends/agentcore.js";
import { LocalSignerBackend } from "./backends/localSigner.js";
import type { PaymentBackend } from "./backends/types.js";
import { atomicToUsd, loadConfig } from "./config.js";
import { runSession } from "./agent/harness.js";
import { AnthropicPlanner, ScriptedPlanner, type Planner } from "./agent/planner.js";
import type { ToolContext } from "./agent/tools.js";
import { CliApprover, PresetApprover, approverIdentity, type Approver } from "./guard/approval.js";
import { ApprovalLedger } from "./guard/approvalLedger.js";
import { DemandLedger } from "./guard/demandLedger.js";
import { SpendLimiter } from "./guard/limits.js";
import { assertNoMainnetConfig, MainnetDetected } from "./guard/network.js";
import { Recorder } from "./log/recorder.js";

interface Args {
  query: string;
  rail?: "x402" | "mpp";
  endpoint?: string;
  endpoints?: string[];
  backend: "agentcore" | "local-signer";
  planner: "anthropic" | "scripted";
  approve: "prompt" | "yes" | "no" | "no-after-first";
  allowLive: boolean;
  runId: string;
  outDir: string;
  label: string;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const label = get("label") ?? "run";
  return {
    query: get("query") ?? "",
    rail: get("rail") as Args["rail"],
    endpoint: get("endpoint"),
    endpoints: get("endpoints")?.split(",").filter(Boolean),
    backend: (get("backend") as Args["backend"]) ?? "local-signer",
    planner: (get("planner") as Args["planner"]) ?? "scripted",
    approve: (get("approve") as Args["approve"]) ?? "prompt",
    allowLive: has("allow-live"),
    runId: get("run-id") ?? `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    outDir: get("out") ?? "artifacts",
    label,
  };
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  // 7節: 起動時の実マネー禁止ガード。mainnet 検出で即停止。
  assertNoMainnetConfig();
  const cfg = loadConfig();

  const rec = new Recorder({
    runId: args.runId,
    dir: resolve(args.outDir, args.runId),
    echo: process.env["ECHO_LOG"] === "true",
  });

  rec.event("harness.config", {
    // T1 の受け入れ条件: 設定値をログに固定する
    region: cfg.region,
    chain: cfg.chain,
    facilitator: cfg.facilitator,
    testnet: cfg.testnet,
    per_call_max_usd: atomicToUsd(cfg.perCallMaxAtomic),
    session_max_usd: atomicToUsd(cfg.sessionMaxAtomic),
    auto_approve: cfg.autoApprove,
    backend: args.backend,
    planner: args.planner,
    allow_live_endpoints: args.allowLive,
    label: args.label,
  });

  const backend: PaymentBackend =
    args.backend === "agentcore"
      ? new AgentCoreBackend(cfg, rec, "buyer-harness", process.env["USER_ID"] ?? "harness-user")
      : new LocalSignerBackend(cfg, rec);

  const approver: Approver =
    args.approve === "prompt"
      ? new CliApprover(rec)
      : new PresetApprover(
          rec,
          { "*": args.approve === "yes" },
          approverIdentity(),
          args.approve === "no-after-first",
        );

  const limiter = new SpendLimiter(cfg);
  const grants = new ApprovalLedger();
  const demands = new DemandLedger({
    maxProcessPaymentAttempts: Number(process.env["MAX_PROCESS_PAYMENT_ATTEMPTS"] ?? "1"),
    maxResendAttempts: Number(process.env["MAX_RESEND_ATTEMPTS"] ?? "1"),
  });

  const planner: Planner =
    args.planner === "anthropic"
      ? new AnthropicPlanner(
          args.endpoint
            ? `${args.endpoint} で有料データを1件買ってほしい。`
            : `${args.query || "testnet で買える課金エンドポイント"}を探して、1件だけ支払ってほしい。`,
        )
      : new ScriptedPlanner(args.query, {
          rail: args.rail,
          endpoint: args.endpoint,
          endpoints: args.endpoints,
        });

  const ctx: ToolContext = {
    payDeps: {
      cfg,
      rec,
      backend,
      limiter,
      approver,
      grants,
      demands,
      merchantKind: (endpoint) =>
        endpoint.startsWith("http://127.0.0.1") || endpoint.startsWith("http://localhost")
          ? "mock-local"
          : "live",
    },
    discoverOpts: {
      registryPath: resolve("config/endpoints.testnet.json"),
      allowLive: args.allowLive,
      directoryUrl: process.env["DISCOVERY_DIRECTORY_URL"],
    },
  };

  let exitCode = 0;
  try {
    await backend.openSession(atomicToUsd(cfg.sessionMaxAtomic), cfg.sessionExpiryMinutes);
    const result = await runSession(rec, planner, ctx);

    const receipts = result.toolCalls
      .filter((c) => c.name === "pay")
      .map((c) => c.result)
      .filter((r): r is { status: string; receipt?: unknown } => typeof r === "object" && r !== null);

    rec.writeJson("summary.json", {
      runId: args.runId,
      label: args.label,
      config: {
        region: cfg.region,
        chain: cfg.chain,
        facilitator: cfg.facilitator,
        testnet: cfg.testnet,
        per_call_max_usd: atomicToUsd(cfg.perCallMaxAtomic),
        session_max_usd: atomicToUsd(cfg.sessionMaxAtomic),
        auto_approve: cfg.autoApprove,
      },
      backend: backend.kind,
      planner: planner.kind,
      tools_exposed_to_model: ["discover", "pay"],
      steps: result.steps,
      results: receipts,
      limits: limiter.snapshot(),
      approval_grants: grants.snapshot(),
      duplicate_guard: demands.snapshot(),
    });

    const last = receipts[receipts.length - 1] as { status?: string } | undefined;
    process.stdout.write(
      `${JSON.stringify({ runId: args.runId, status: last?.status ?? "no-pay", dir: rec.dir })}\n`,
    );
  } catch (err) {
    if (err instanceof MainnetDetected) {
      rec.event("harness.halt", { reason: "mainnet_detected", detail: err.message });
      process.stderr.write(`実マネー検出のため停止: ${err.message}\n`);
      exitCode = 2;
    } else {
      rec.event("harness.error", { error: (err as Error).message });
      process.stderr.write(`エラー: ${(err as Error).message}\n`);
      exitCode = 1;
    }
  } finally {
    // セッション境界: 鍵・決済セッションをまたがせない
    await backend.closeSession().catch(() => undefined);
  }
  return exitCode;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (isMain || process.argv[1]?.endsWith("cli.ts")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

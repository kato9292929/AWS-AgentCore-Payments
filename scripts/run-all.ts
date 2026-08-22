/**
 * 8節の採取物を一通り取る。各シナリオを独立プロセスで走らせ、
 * artifacts/INDEX.json に「採れた／採れない」を項目単位で残す。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface Scenario {
  label: string;
  args: string[];
  env?: Record<string, string>;
  /** 標準入力に流す文字列（CLI 承認プロンプト用）。 */
  stdin?: string;
  expect: string;
  purpose: string;
}

const SCENARIOS: Scenario[] = [
  {
    label: "x402-success",
    args: ["--query=x402", "--rail=x402", "--approve=yes"],
    expect: "success",
    purpose: "T4: x402 経路の 402→pay→success 一周",
  },
  {
    label: "mpp-success",
    args: ["--query=mpp", "--rail=mpp", "--approve=yes"],
    expect: "success",
    purpose: "T5: MPP 経路の 402→pay→success 一周",
  },
  {
    label: "limit-exceeded",
    args: [
      "--query=premium",
      "--rail=x402",
      "--endpoint=http://127.0.0.1:8402/x402/premium",
      "--approve=yes",
    ],
    expect: "declined",
    purpose: "T6: per_call_max 超過で decline（再送が発生しないこと）",
  },
  {
    label: "session-cap-exceeded",
    args: ["--query=x402", "--rail=x402", "--endpoint=http://127.0.0.1:8402/x402/weather", "--approve=yes"],
    env: { PER_CALL_MAX_USD: "0.05", SESSION_MAX_USD: "0.005" },
    expect: "declined",
    purpose: "T6: session_max 超過で decline",
  },
  {
    label: "not-approved",
    args: ["--query=x402", "--rail=x402", "--endpoint=http://127.0.0.1:8402/x402/weather", "--approve=no"],
    expect: "declined",
    purpose: "T7: 初回エンドポイントを承認しなければ決済に進まない",
  },
  {
    label: "cli-approval-prompt",
    args: ["--query=x402", "--rail=x402", "--endpoint=http://127.0.0.1:8402/x402/weather", "--approve=prompt"],
    stdin: "y\n",
    expect: "success",
    purpose: "T7: 対話 CLI で人間が承認した記録（誰が・いつ・いくら）",
  },
  {
    label: "cli-approval-denied",
    args: ["--query=x402", "--rail=x402", "--endpoint=http://127.0.0.1:8402/x402/weather", "--approve=prompt"],
    stdin: "n\n",
    expect: "declined",
    purpose: "T7: 対話 CLI で人間が否認した記録",
  },
  {
    label: "mainnet-halt",
    args: [
      "--query=x402",
      "--rail=x402",
      "--endpoint=http://127.0.0.1:8402/x402/mainnet-trap",
      "--approve=yes",
    ],
    expect: "halt",
    purpose: "7節: mainnet を提示されたら決済せずセッションごと停止",
  },
];

interface RunOutcome {
  label: string;
  purpose: string;
  expect: string;
  runId: string | null;
  status: string;
  exitCode: number;
  artifactsDir: string | null;
  ok: boolean;
}

async function runOne(s: Scenario): Promise<RunOutcome> {
  const runId = `${s.label}`;
  const child = spawn(
    "npx",
    ["tsx", "src/cli.ts", `--label=${s.label}`, `--run-id=${runId}`, ...s.args],
    {
      env: { ...process.env, APPROVER: process.env["APPROVER"] ?? "harness-operator", ...s.env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (s.stdin) child.stdin.write(s.stdin);
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  child.stderr.on("data", (d) => (stderr += String(d)));

  const exitCode: number = await new Promise((res) => child.on("close", (c) => res(c ?? -1)));

  let status = "unknown";
  if (exitCode === 2) status = "halt";
  else {
    const m = /\{"runId".*\}/.exec(stdout);
    if (m) status = (JSON.parse(m[0]) as { status: string }).status;
  }

  const dir = resolve("artifacts", runId);
  const ok = status === s.expect;
  process.stdout.write(
    `${ok ? "OK  " : "NG  "} ${s.label.padEnd(22)} status=${status.padEnd(9)} exit=${exitCode}\n`,
  );
  if (!ok && stderr) process.stdout.write(`     stderr: ${stderr.trim().split("\n").slice(-3).join(" / ")}\n`);

  return {
    label: s.label,
    purpose: s.purpose,
    expect: s.expect,
    runId,
    status,
    exitCode,
    artifactsDir: existsSync(dir) ? dir : null,
    ok,
  };
}

const results: RunOutcome[] = [];
for (const s of SCENARIOS) {
  results.push(await runOne(s));
}

// 採取物の有無を項目単位で集計する（8節）
const collected = results.map((r) => {
  if (!r.artifactsDir) return { ...r, collected: {} };
  const events = readFileSync(join(r.artifactsDir, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const types = new Set(events.map((e) => String(e["type"])));
  const has = (t: string): boolean => types.has(t);
  const retryEvents = events.filter(
    (e) => e["type"] === "http.request" && String(e["phase"] ?? "").includes("retry"),
  );
  return {
    ...r,
    collected: {
      discover_candidates: has("tool.discover.result"),
      "402_response": events.some((e) => e["type"] === "http.response" && e["status"] === 402),
      limit_decision: has("guard.limit.decision"),
      approval_record: has("approval.decision") || has("approval.point"),
      retry_request_sent: retryEvents.length > 0,
      success_200: events.some((e) => e["type"] === "http.response" && e["status"] === 200),
      receipt: has("pay.success"),
      mainnet_halt: has("guard.mainnet.detected") || has("harness.halt"),
    },
  };
});

writeFileSync(
  resolve("artifacts", "INDEX.json"),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      note:
        "merchant は mock-local（ローカル模擬売り手）。公開 testnet エンドポイントへの到達は " +
        "本セッションの egress ポリシーで不可。docs/T4-T5-blocked.md を参照。",
      scenarios: collected,
      allExpected: collected.every((c) => c.ok),
    },
    null,
    2,
  )}\n`,
  "utf8",
);

process.stdout.write(`\n${collected.filter((c) => c.ok).length}/${collected.length} シナリオが期待どおり\n`);
process.exit(collected.every((c) => c.ok) ? 0 : 1);

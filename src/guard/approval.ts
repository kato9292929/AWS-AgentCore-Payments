import { createInterface } from "node:readline/promises";
import { userInfo } from "node:os";
import type { Recorder } from "../log/recorder.js";

export interface ApprovalRequest {
  endpoint: string;
  rail: string;
  amountUsd: string;
  asset: string;
  network: string;
  payTo: string;
  reason: "first_time_endpoint" | "over_per_call_limit";
}

export interface ApprovalRecord extends ApprovalRequest {
  approved: boolean;
  approver: string;
  at: string;
  mode: "cli-prompt" | "preset" | "auto";
}

/**
 * 層3（問題C：判断の責任）
 *
 * 自動承認は testnet でも既定オフ。承認が取れるまで pay は決済に進まない。
 */
export interface Approver {
  ask(req: ApprovalRequest): Promise<ApprovalRecord>;
}

/** 対話 CLI。人間が y/N を打つまで待つ。 */
export class CliApprover implements Approver {
  constructor(private readonly rec: Recorder) {}

  async ask(req: ApprovalRequest): Promise<ApprovalRecord> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      process.stdout.write(
        [
          "",
          "──────── 人間承認が必要 ────────",
          `理由      : ${req.reason}`,
          `エンドポイント: ${req.endpoint}`,
          `レール    : ${req.rail}`,
          `金額      : ${req.amountUsd} USD (${req.asset})`,
          `ネットワーク: ${req.network}  払先: ${req.payTo}`,
          "────────────────────────────────",
          "",
        ].join("\n"),
      );
      const answer = (await rl.question("この支払いを承認しますか? [y/N] ")).trim().toLowerCase();
      const approved = answer === "y" || answer === "yes";
      return this.record(req, approved, "cli-prompt");
    } finally {
      rl.close();
    }
  }

  private record(req: ApprovalRequest, approved: boolean, mode: ApprovalRecord["mode"]): ApprovalRecord {
    const r: ApprovalRecord = {
      ...req,
      approved,
      approver: approverIdentity(),
      at: new Date().toISOString(),
      mode,
    };
    this.rec.event("approval.decision", { ...r });
    return r;
  }
}

/**
 * 非対話実行（CI・スクリプト）用。
 * 事前に人間が決めた回答を渡す。回答が無いエンドポイントは自動で「否認」。
 * 「承認されていないのに決済が起きた」を構造的に作れないようにする。
 */
export class PresetApprover implements Approver {
  constructor(
    private readonly rec: Recorder,
    private readonly decisions: Record<string, boolean>,
    private readonly approver: string,
  ) {}

  async ask(req: ApprovalRequest): Promise<ApprovalRecord> {
    const key = `${req.endpoint}`;
    const approved = this.decisions[key] ?? this.decisions["*"] ?? false;
    const r: ApprovalRecord = {
      ...req,
      approved,
      approver: this.approver,
      at: new Date().toISOString(),
      mode: "preset",
    };
    this.rec.event("approval.decision", { ...r });
    return r;
  }
}

export function approverIdentity(): string {
  try {
    return process.env["APPROVER"] ?? `${userInfo().username}@${process.env["HOSTNAME"] ?? "local"}`;
  } catch {
    return process.env["APPROVER"] ?? "unknown";
  }
}

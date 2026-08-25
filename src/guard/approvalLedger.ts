import { atomicToUsd } from "../config.js";
import type { ApprovalRecord } from "./approval.js";
import { originOf } from "./limits.js";

/**
 * 層3の「承認の有効範囲」。
 *
 * 以前は「一度払ったオリジンは以後ノーチェック」だった。
 * これは docs/session-boundary.md で自分で挙げた穴で、
 * 同一オリジンの別リソースが per_call 上限まで無承認で通ってしまう。
 *
 * ここでは承認に **金額の天井** を付ける。人間が $0.01 を承認したなら、
 * 同じオリジンでもそれを超える請求はもう一度聞く。
 * 承認はセッション内でのみ有効で、セッションをまたいで持ち越さない。
 */
export interface Grant {
  origin: string;
  /** この金額までは再承認なしで払ってよい。 */
  ceilingAtomic: bigint;
  approver: string;
  at: string;
}

export type Coverage =
  | { covered: true; grant: Grant }
  | { covered: false; reason: "first_time_endpoint" | "over_granted_amount"; grant?: Grant };

export class ApprovalLedger {
  private readonly grants = new Map<string, Grant>();

  /** 承認なしで払えるか。 */
  covers(endpoint: string, amountAtomic: bigint): Coverage {
    const origin = originOf(endpoint);
    const grant = this.grants.get(origin);
    if (!grant) return { covered: false, reason: "first_time_endpoint" };
    if (amountAtomic > grant.ceilingAtomic) {
      return { covered: false, reason: "over_granted_amount", grant };
    }
    return { covered: true, grant };
  }

  /**
   * 人間の承認を記録する。天井は「承認された金額そのもの」。
   * 承認額より高い請求は、同じオリジンでももう一度人間に聞く。
   */
  record(endpoint: string, amountAtomic: bigint, decision: ApprovalRecord): Grant | undefined {
    if (!decision.approved) return undefined;
    const origin = originOf(endpoint);
    const existing = this.grants.get(origin);
    const ceiling = existing && existing.ceilingAtomic > amountAtomic ? existing.ceilingAtomic : amountAtomic;
    const grant: Grant = { origin, ceilingAtomic: ceiling, approver: decision.approver, at: decision.at };
    this.grants.set(origin, grant);
    return grant;
  }

  static describe(grant: Grant): string {
    return `${grant.origin} まで ${atomicToUsd(grant.ceilingAtomic)} USD/回（今セッション内）`;
  }

  snapshot(): Array<Record<string, string>> {
    return [...this.grants.values()].map((g) => ({
      origin: g.origin,
      ceiling_usd: atomicToUsd(g.ceilingAtomic),
      approver: g.approver,
      at: g.at,
    }));
  }
}

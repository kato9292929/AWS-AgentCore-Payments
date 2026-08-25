import { atomicToUsd, type HarnessConfig } from "../config.js";
import type { Decision } from "../types.js";

/**
 * 層2（問題B：支出範囲の拘束）
 *
 * pay の内側に固定する。モデルからは per_call_max / session_max を
 * 引数でも環境変数でも触れない（loadConfig はハーネス起動時に一度だけ読む）。
 */
export class SpendLimiter {
  private spentAtomic = 0n;

  constructor(private readonly cfg: HarnessConfig) {}

  get spent(): bigint {
    return this.spentAtomic;
  }

  get remaining(): bigint {
    const r = this.cfg.sessionMaxAtomic - this.spentAtomic;
    return r > 0n ? r : 0n;
  }

  /**
   * 402 で提示された金額だけを評価する。決済の前に必ず 1 回だけ呼ぶ。
   * 戻り値が within 以外なら、呼び出し側は再送を行ってはならない。
   *
   * 承認の要否はここでは決めない（ApprovalLedger の仕事）。
   * 「金額の拘束（層2）」と「判断の責任（層3）」を混ぜると、
   * どちらで止まったのかがログから読めなくなるため分けてある。
   */
  evaluate(amountAtomic: bigint): Decision {
    const detail = {
      amount_usd: atomicToUsd(amountAtomic),
      per_call_max_usd: atomicToUsd(this.cfg.perCallMaxAtomic),
      session_max_usd: atomicToUsd(this.cfg.sessionMaxAtomic),
      session_spent_usd: atomicToUsd(this.spentAtomic),
    };

    if (amountAtomic <= 0n) {
      return { verdict: "limit_exceeded", reason: "invalid_amount", rule: "invalid_amount", detail };
    }
    if (amountAtomic > this.cfg.perCallMaxAtomic) {
      // 1回あたり上限。AgentCore の SessionLimits には対応する概念が無いので、
      // ここで落ちた事実そのものが「ハーネス側にしか無い拘束」の証拠になる。
      return { verdict: "limit_exceeded", reason: "limit_exceeded", rule: "per_call_max", detail };
    }
    if (this.spentAtomic + amountAtomic > this.cfg.sessionMaxAtomic) {
      return { verdict: "limit_exceeded", reason: "limit_exceeded", rule: "session_max", detail };
    }
    return { verdict: "within" };
  }

  /** 決済が成立した後にだけ呼ぶ。 */
  commit(amountAtomic: bigint): void {
    this.spentAtomic += amountAtomic;
  }

  snapshot(): Record<string, string> {
    return {
      spent_usd: atomicToUsd(this.spentAtomic),
      remaining_usd: atomicToUsd(this.remaining),
      per_call_max_usd: atomicToUsd(this.cfg.perCallMaxAtomic),
      session_max_usd: atomicToUsd(this.cfg.sessionMaxAtomic),
    };
  }
}

/** 「初回エンドポイント」はオリジン単位で判定する。 */
export function originOf(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return endpoint;
  }
}

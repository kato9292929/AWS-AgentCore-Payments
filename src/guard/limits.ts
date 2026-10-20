import { atomicToUsd, type HarnessConfig } from "../config.js";
import type { Decision } from "../types.js";

/**
 * 自前ガード（層2）をどこまで効かせるか。
 *  both           … 既定。ハーネスの per_call / session と AgentCore の SessionLimits を二重にかける
 *  agentcore-only … AC-1 の測定用。ハーネス側の上限判定を「判定はするが止めない」にして、
 *                   AgentCore 側だけで止まるかを見る。承認（層3）と mainnet 停止は外さない。
 */
export type GuardMode = "both" | "agentcore-only";

export interface SpendLimiterOptions {
  guards?: GuardMode;
}

/** upto の予約。上限額で押さえ、settle 後に実額で確定して差額を返す。 */
export interface Reservation {
  id: number;
  capAtomic: bigint;
}

/**
 * 層2（問題B：支出範囲の拘束）
 *
 * pay の内側に固定する。モデルからは per_call_max / session_max を
 * 引数でも環境変数でも触れない（loadConfig はハーネス起動時に一度だけ読む）。
 */
export class SpendLimiter {
  private spentAtomic = 0n;
  /** 決済中（upto の上限額で押さえている分）。session_max の判定に含める。 */
  private reservedAtomic = 0n;
  private readonly open = new Map<number, Reservation>();
  private nextId = 1;
  readonly guards: GuardMode;

  constructor(
    private readonly cfg: HarnessConfig,
    opts: SpendLimiterOptions = {},
  ) {
    this.guards = opts.guards ?? "both";
  }

  /** false のとき、evaluate の結果は記録だけして決済を止めない（agentcore-only）。 */
  get enforcing(): boolean {
    return this.guards === "both";
  }

  get spent(): bigint {
    return this.spentAtomic;
  }

  get reserved(): bigint {
    return this.reservedAtomic;
  }

  get remaining(): bigint {
    const r = this.cfg.sessionMaxAtomic - this.spentAtomic - this.reservedAtomic;
    return r > 0n ? r : 0n;
  }

  /**
   * 402 で提示された金額だけを評価する。決済の前に必ず 1 回だけ呼ぶ。
   * 戻り値が within 以外なら、呼び出し側は再送を行ってはならない。
   * upto のときは上限額（maxAmountRequired）を渡す。実請求額は settle まで分からない。
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
      session_reserved_usd: atomicToUsd(this.reservedAtomic),
    };

    if (amountAtomic <= 0n) {
      return { verdict: "limit_exceeded", reason: "invalid_amount", rule: "invalid_amount", detail };
    }
    if (amountAtomic > this.cfg.perCallMaxAtomic) {
      // 1回あたり上限。AgentCore の SessionLimits には対応する概念が無いので、
      // ここで落ちた事実そのものが「ハーネス側にしか無い拘束」の証拠になる。
      return { verdict: "limit_exceeded", reason: "limit_exceeded", rule: "per_call_max", detail };
    }
    if (this.spentAtomic + this.reservedAtomic + amountAtomic > this.cfg.sessionMaxAtomic) {
      return { verdict: "limit_exceeded", reason: "limit_exceeded", rule: "session_max", detail };
    }
    return { verdict: "within" };
  }

  /** exact: 決済が成立した後にだけ呼ぶ。 */
  commit(amountAtomic: bigint): void {
    this.spentAtomic += amountAtomic;
  }

  /** upto: 署名の前に上限額で押さえる。以降の evaluate はこの分を使用済みとして扱う。 */
  reserve(capAtomic: bigint): Reservation {
    const r = { id: this.nextId++, capAtomic };
    this.open.set(r.id, r);
    this.reservedAtomic += capAtomic;
    return r;
  }

  /**
   * upto: settle 後に実額で確定し、差額を解放する。
   * 実額が上限額を超えていたら（売り手の過大請求）、実額で計上したうえで overcharge を返す。
   */
  settle(r: Reservation, actualAtomic: bigint): { released: bigint; overcharge: bigint } {
    if (!this.open.delete(r.id)) throw new Error(`予約 ${r.id} は既に閉じている`);
    this.reservedAtomic -= r.capAtomic;
    this.spentAtomic += actualAtomic;
    const diff = r.capAtomic - actualAtomic;
    return diff >= 0n ? { released: diff, overcharge: 0n } : { released: 0n, overcharge: -diff };
  }

  /** upto: 決済に至らなかった予約を全額解放する。 */
  release(r: Reservation): void {
    if (!this.open.delete(r.id)) return;
    this.reservedAtomic -= r.capAtomic;
  }

  snapshot(): Record<string, string> {
    return {
      spent_usd: atomicToUsd(this.spentAtomic),
      reserved_usd: atomicToUsd(this.reservedAtomic),
      remaining_usd: atomicToUsd(this.remaining),
      per_call_max_usd: atomicToUsd(this.cfg.perCallMaxAtomic),
      session_max_usd: atomicToUsd(this.cfg.sessionMaxAtomic),
      guards: this.guards,
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

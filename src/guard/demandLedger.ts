import { createHash, randomUUID } from "node:crypto";
import type { PaymentDemand } from "../types.js";

/**
 * 二重支払いと再送ループの抑止。
 *
 * 効かせたい事故は 2 つある。
 *  (a) 1 回の pay() の中で ProcessPayment を 2 回叩く（＝2 回署名する）
 *  (b) 402 が返り続けて再送を繰り返す
 *
 * (a) は clientToken を demand ごとに固定して AgentCore 側の冪等性に載せ、
 *     さらにこちら側でも 2 回目を拒否する。二重に止める。
 * (b) は再送回数を上限で切る。上限に達したら**署名し直さない**。
 *
 * 同じ商品をセッション内で 2 回買うのは正当なので、そこは止めない。
 * ただし「同じ請求内容が 2 回成立した」ことは気づけるようにログへ残す。
 */

export interface LedgerEntry {
  /** AgentCore の ProcessPayment に渡す冪等トークン。demand ごとに固定。 */
  clientToken: string;
  processPaymentAttempts: number;
  resendAttempts: number;
  settled: boolean;
}

export type LedgerVerdict =
  | { ok: true; entry: LedgerEntry }
  | { ok: false; reason: "duplicate_payment_blocked" | "retry_limit_exceeded" };

export interface DemandLedgerOptions {
  /** 1 回の pay() で許す ProcessPayment 回数。 */
  maxProcessPaymentAttempts?: number;
  /** 1 回の pay() で許す再送回数。 */
  maxResendAttempts?: number;
}

export class DemandLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  /** 経済的に同一の請求が何回成立したか（セッション通算）。止めはしないが記録する。 */
  private readonly settledFingerprints = new Map<string, number>();
  private readonly maxProcessPaymentAttempts: number;
  private readonly maxResendAttempts: number;

  constructor(opts: DemandLedgerOptions = {}) {
    this.maxProcessPaymentAttempts = opts.maxProcessPaymentAttempts ?? 1;
    this.maxResendAttempts = opts.maxResendAttempts ?? 1;
  }

  /**
   * 請求の経済的な中身だけで作る指紋。
   * MPP のチャレンジ id は 402 のたびに変わるので指紋には入れない
   * （入れると同一請求を同一と判定できなくなる）。
   */
  static fingerprint(endpoint: string, demand: PaymentDemand): string {
    const material = [
      endpoint,
      demand.rail,
      demand.scheme,
      demand.network,
      demand.asset.toLowerCase(),
      demand.payTo.toLowerCase(),
      demand.amountAtomic.toString(),
    ].join("|");
    return createHash("sha256").update(material).digest("hex").slice(0, 32);
  }

  /** pay() 1 回ぶんのキー。呼び出しをまたぐ再購入は正当なので分ける。 */
  static key(payCallId: string, fingerprint: string): string {
    return `${payCallId}:${fingerprint}`;
  }

  /** ProcessPayment を叩く直前に呼ぶ。 */
  beginPayment(key: string): LedgerVerdict {
    const entry = this.entries.get(key) ?? {
      clientToken: randomUUID(),
      processPaymentAttempts: 0,
      resendAttempts: 0,
      settled: false,
    };
    if (entry.settled) return { ok: false, reason: "duplicate_payment_blocked" };
    if (entry.processPaymentAttempts >= this.maxProcessPaymentAttempts) {
      return { ok: false, reason: "duplicate_payment_blocked" };
    }
    entry.processPaymentAttempts += 1;
    this.entries.set(key, entry);
    return { ok: true, entry };
  }

  /** 再送する直前に呼ぶ。 */
  beginResend(key: string): LedgerVerdict {
    const entry = this.entries.get(key);
    if (!entry) throw new Error("beginPayment を先に呼ぶこと");
    if (entry.resendAttempts >= this.maxResendAttempts) {
      return { ok: false, reason: "retry_limit_exceeded" };
    }
    entry.resendAttempts += 1;
    return { ok: true, entry };
  }

  /** 200 を受けた後に呼ぶ。戻り値は「この請求内容がセッション内で何回目の成立か」。 */
  markSettled(key: string, fingerprint: string): number {
    const entry = this.entries.get(key);
    if (entry) entry.settled = true;
    const count = (this.settledFingerprints.get(fingerprint) ?? 0) + 1;
    this.settledFingerprints.set(fingerprint, count);
    return count;
  }

  snapshot(): Record<string, unknown> {
    return {
      max_process_payment_attempts: this.maxProcessPaymentAttempts,
      max_resend_attempts: this.maxResendAttempts,
      tracked_demands: this.entries.size,
      settled_fingerprints: this.settledFingerprints.size,
    };
  }
}

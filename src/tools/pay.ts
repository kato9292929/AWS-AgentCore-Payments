import type { PaymentBackend } from "../backends/types.js";
import { atomicToUsd, type HarnessConfig } from "../config.js";
import type { Approver } from "../guard/approval.js";
import { SpendLimiter } from "../guard/limits.js";
import { MainnetDetected } from "../guard/network.js";
import type { Recorder } from "../log/recorder.js";
import * as mpp from "../rails/mpp.js";
import * as x402 from "../rails/x402.js";
import type { PayResult, Rail } from "../types.js";

export interface PayDeps {
  cfg: HarnessConfig;
  rec: Recorder;
  backend: PaymentBackend;
  limiter: SpendLimiter;
  approver: Approver;
  /** ログに live / mock-local を残すための判定。 */
  merchantKind: (endpoint: string) => "live" | "mock-local";
}

/**
 * ツール2: pay(endpoint, request)
 *
 * 役割: 指定エンドポイントに対し 402 → 署名 → 再送 を1周する。
 * 内側: 三層ラッパーを通す。上限内かつ承認済みなら決済、そうでなければ実行しない。
 * モデルに返すもの: success/receipt、または needs_approval / declined の理由コード。
 *
 * モデルはこの関数の内側にある上限・承認・鍵に触れない。
 * 引数は endpoint と request だけで、上限値も鍵も渡せない。
 */
export async function pay(
  deps: PayDeps,
  endpoint: string,
  request: { rail?: Rail; method?: string } = {},
): Promise<PayResult> {
  const { cfg, rec, backend, limiter, approver } = deps;
  rec.event("tool.pay.call", { endpoint, request });

  try {
    // ---- 4. 素のリクエストを投げて 402 と支払い要求を受ける ----
    const rail: Rail = request.rail ?? guessRail(endpoint);
    const bare = rail === "x402" ? await x402.probe(rec, endpoint) : await mpp.probe(rec, endpoint);

    if (bare.status === 200) {
      rec.event("pay.no_payment_required", { endpoint });
      return { status: "declined", reason: "no_payment_required" };
    }
    if (bare.status !== 402) {
      return { status: "error", reason: `unexpected_status_${bare.status}` };
    }

    const parsed = rail === "x402" ? x402.parse402(bare) : mpp.parse402(bare);
    const demand = parsed.demand;

    rec.event("pay.demand", {
      endpoint,
      rail: demand.rail,
      scheme: demand.scheme,
      network: demand.network,
      amount_atomic: demand.amountAtomic.toString(),
      amount_usd: atomicToUsd(demand.amountAtomic),
      asset: demand.asset,
      payTo: demand.payTo,
    });

    // ---- 5. 上限ラッパー（層2）。ここを通らずに決済へ進む経路は無い ----
    const decision = limiter.evaluate(endpoint, demand.amountAtomic);
    rec.event("guard.limit.decision", {
      endpoint,
      verdict: decision.verdict,
      ...("reason" in decision ? { reason: decision.reason } : {}),
      ...("detail" in decision ? decision.detail : {}),
      ...limiter.snapshot(),
    });

    if (decision.verdict === "limit_exceeded") {
      // 承認点2: 上限超過。人間に承認を求めることすらせず、決済に進まない。
      rec.event("approval.point", {
        point: 2,
        name: "上限超過時の停止",
        endpoint,
        asked_human: false,
        approved: false,
        payment_attempted: false,
        note: "per_call_max / session_max を超えたため decline。再送は発生しない。",
        ...decision.detail,
      });
      rec.event("pay.declined", { endpoint, reason: decision.reason, retry_sent: false });
      return { status: "declined", reason: decision.reason, detail: decision.detail };
    }

    if (decision.verdict === "needs_approval") {
      // 承認点1: 初回エンドポイントへの支払い。
      if (cfg.autoApprove) {
        rec.event("approval.point", {
          point: 1,
          name: "初回エンドポイントへの支払い",
          endpoint,
          asked_human: false,
          approved: true,
          note: "AUTO_APPROVE=true が明示指定された（既定は false）",
        });
      } else {
        const record = await approver.ask({
          endpoint,
          rail: demand.rail,
          amountUsd: atomicToUsd(demand.amountAtomic),
          asset: demand.asset,
          network: demand.network,
          payTo: demand.payTo,
          reason: "first_time_endpoint",
        });
        rec.event("approval.point", {
          point: 1,
          name: "初回エンドポイントへの支払い",
          endpoint,
          asked_human: true,
          approved: record.approved,
          approver: record.approver,
          at: record.at,
          amount_usd: record.amountUsd,
        });
        if (!record.approved) {
          rec.event("pay.declined", { endpoint, reason: "not_approved", retry_sent: false });
          return {
            status: "declined",
            reason: "not_approved",
            detail: { approver: record.approver, at: record.at },
          };
        }
      }
    }

    // ---- 6. 承認済み。決済証明を作る（鍵はこの内側にしか無い） ----
    const proof = await backend.processPayment(demand);
    rec.event("pay.proof", {
      endpoint,
      rail: proof.rail,
      status: proof.status,
      processPaymentId: proof.processPaymentId,
      proofSource: backend.kind,
    });

    // ---- 再送 ----
    const retry =
      proof.rail === "x402"
        ? await x402.retryWithPayment(
            rec,
            endpoint,
            Number(proof.version),
            demand.scheme,
            demand.network,
            proof.payload,
          )
        : await mpp.retryWithCredential(rec, endpoint, proof.paymentCredential);

    if (retry.status < 200 || retry.status >= 300) {
      rec.event("pay.retry_failed", { endpoint, status: retry.status, body: retry.bodyText.slice(0, 400) });
      return { status: "error", reason: `retry_status_${retry.status}` };
    }

    // ---- 7. 200/success と receipt ----
    const merchant = deps.merchantKind(endpoint);
    const receipt =
      proof.rail === "x402"
        ? x402.receiptFrom(retry, demand, backend.kind, merchant)
        : mpp.receiptFrom(retry, demand, backend.kind, merchant);

    limiter.commit(endpoint, demand.amountAtomic);
    rec.event("pay.success", { endpoint, receipt, ...limiter.snapshot() });

    return { status: "success", receipt };
  } catch (err) {
    if (err instanceof MainnetDetected) {
      // 7節「実マネー禁止フラグ」。ここに来たらセッションごと落とす。
      rec.event("guard.mainnet.detected", { endpoint, where: err.where, value: err.value });
      throw err;
    }
    rec.event("pay.error", { endpoint, error: (err as Error).message });
    return { status: "error", reason: (err as Error).message };
  }
}

function guessRail(endpoint: string): Rail {
  return endpoint.includes("/mpp") ? "mpp" : "x402";
}

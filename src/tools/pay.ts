import { randomUUID } from "node:crypto";
import type { PaymentBackend } from "../backends/types.js";
import { atomicToUsd, type HarnessConfig } from "../config.js";
import type { ApprovalRecord, Approver } from "../guard/approval.js";
import { ApprovalLedger, type Grant } from "../guard/approvalLedger.js";
import { DemandLedger } from "../guard/demandLedger.js";
import { SpendLimiter, type Reservation } from "../guard/limits.js";
import type { PayToAllowlist } from "../guard/payToAllowlist.js";
import { MainnetDetected } from "../guard/network.js";
import type { Recorder } from "../log/recorder.js";
import * as mpp from "../rails/mpp.js";
import * as x402 from "../rails/x402.js";
import type { PayResult, Rail, Receipt } from "../types.js";

export interface PayDeps {
  cfg: HarnessConfig;
  rec: Recorder;
  backend: PaymentBackend;
  limiter: SpendLimiter;
  approver: Approver;
  grants: ApprovalLedger;
  demands: DemandLedger;
  /** 支払い先の allowlist（AC-2）。ここに無い payTo / network には署名に進まない。 */
  payTo: PayToAllowlist;
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
 *
 * 通る順番（この順番自体がガードレール）:
 *   402 を受ける → 支払い先の allowlist → 層2で金額を拘束 → 層3で承認を取る
 *   → 二重支払い/再送回数を見る → 層1（鍵）で署名 → 再送 → receipt
 *
 * upto（上限額だけ決めて実額を請求される方式）は、層2で上限額を予約し、
 * settle 後に実額で確定して差額を解放する。exact は従来どおり成立後に金額を計上する。
 */
export async function pay(
  deps: PayDeps,
  endpoint: string,
  request: { rail?: Rail; method?: string } = {},
): Promise<PayResult> {
  const { cfg, rec, backend, limiter, approver, grants, demands } = deps;
  let reservation: Reservation | undefined;
  // pay() 1 回ごとの識別子。同じ商品をあとでもう一度買うのは正当なので、
  // 二重支払い判定はこの呼び出しの内側に閉じる。
  const payCallId = randomUUID();
  rec.event("tool.pay.call", { endpoint, request, payCallId });
  /**
   * 決済に至らなかった upto の予約を解放する。
   * 署名済みで 402 / 非 2xx が返った場合も解放する（ハーネス側の会計）。
   * AgentCore 側の予算がどう減ったかは別に記録する（AC-3）。
   */
  const releaseReservation = (): void => {
    if (!reservation) return;
    limiter.release(reservation);
    rec.event("guard.limit.released", { endpoint, cap_atomic: reservation.capAtomic.toString(), ...limiter.snapshot() });
    reservation = undefined;
  };

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
    const fingerprint = DemandLedger.fingerprint(endpoint, demand);
    const ledgerKey = DemandLedger.key(payCallId, fingerprint);

    rec.event("pay.demand", {
      endpoint,
      rail: demand.rail,
      scheme: demand.scheme,
      network: demand.network,
      amount_atomic: demand.amountAtomic.toString(),
      amount_usd: atomicToUsd(demand.amountAtomic),
      asset: demand.asset,
      payTo: demand.payTo,
      fingerprint,
    });

    // ---- 5. 支払い先の allowlist。誰に払うかは AgentCore 側で縛れない ----
    const payToVerdict = deps.payTo.check(demand);
    rec.event("guard.payto.decision", {
      endpoint,
      payTo: demand.payTo,
      network: demand.network,
      allowed: payToVerdict.allowed,
      ...(payToVerdict.allowed ? { entry: payToVerdict.entry.label } : { reason: payToVerdict.reason }),
    });
    if (!payToVerdict.allowed) {
      rec.event("pay.declined", {
        endpoint,
        reason: payToVerdict.reason,
        retry_sent: false,
        process_payment_called: false,
      });
      return { status: "declined", reason: payToVerdict.reason, detail: { payTo: demand.payTo, network: demand.network } };
    }

    // ---- 5a. 層2: 金額の拘束。ここを通らずに決済へ進む経路は無い ----
    // agentcore-only のときは判定だけ残して止めない（AgentCore 側だけで止まるかを測る）。
    const harnessDecision = limiter.evaluate(demand.amountAtomic);
    const decision = limiter.enforcing ? harnessDecision : ({ verdict: "within" } as const);
    rec.event("guard.limit.decision", {
      endpoint,
      verdict: decision.verdict,
      guards: limiter.guards,
      ...(limiter.enforcing ? {} : { harness_verdict: harnessDecision.verdict, enforced: false }),
      scheme: demand.scheme,
      ...("reason" in harnessDecision ? { reason: harnessDecision.reason } : {}),
      ...("rule" in harnessDecision ? { rule: harnessDecision.rule } : {}),
      ...("detail" in harnessDecision ? harnessDecision.detail : {}),
      ...limiter.snapshot(),
      // AgentCore の SessionLimits はセッション累計しか持たない。
      // per_call_max で落ちた場合、それはハーネス側にしか無い拘束である。
      enforced_by: !limiter.enforcing
        ? "AgentCore SessionLimits only (--guards=agentcore-only)"
        : "rule" in decision && decision.rule === "per_call_max"
          ? "harness-only (AgentCore に該当 API 無し)"
          : "harness + AgentCore SessionLimits",
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
        rule: decision.rule,
        note: "上限を超えたため decline。署名も再送も発生しない。",
        ...decision.detail,
      });
      rec.event("pay.declined", {
        endpoint,
        reason: decision.reason,
        rule: decision.rule,
        retry_sent: false,
        process_payment_called: false,
      });
      return {
        status: "declined",
        reason: decision.reason,
        detail: { ...decision.detail, rule: decision.rule },
      };
    }

    // ---- 5b. 層3: 承認の有効範囲を見る ----
    const coverage = grants.covers(endpoint, demand.amountAtomic);
    let approvalForReceipt: Receipt["approval"];

    if (coverage.covered) {
      rec.event("guard.approval.covered", {
        endpoint,
        scope: ApprovalLedger.describe(coverage.grant),
        note: "既存の承認範囲内なので人間に再度聞かない",
      });
      approvalForReceipt = {
        approver: coverage.grant.approver,
        at: coverage.grant.at,
        scope: ApprovalLedger.describe(coverage.grant),
      };
    } else {
      const decisionRecord = await askHuman(deps, endpoint, demand, coverage.reason, coverage.grant);
      if (!decisionRecord.approved) {
        rec.event("pay.declined", {
          endpoint,
          reason: "not_approved",
          retry_sent: false,
          process_payment_called: false,
        });
        return {
          status: "declined",
          reason: "not_approved",
          detail: { approver: decisionRecord.approver, at: decisionRecord.at },
        };
      }
      const grant = grants.record(endpoint, demand.amountAtomic, decisionRecord);
      if (!grant) throw new Error("承認済みなのに grant が作られなかった");
      rec.event("guard.approval.granted", {
        endpoint,
        scope: ApprovalLedger.describe(grant),
        grants: grants.snapshot(),
      });
      approvalForReceipt = {
        approver: decisionRecord.approver,
        at: decisionRecord.at,
        scope: ApprovalLedger.describe(grant),
      };
    }

    // ---- 5c. 二重支払いの抑止 ----
    const begin = demands.beginPayment(ledgerKey);
    if (!begin.ok) {
      rec.event("guard.duplicate.blocked", {
        endpoint,
        fingerprint,
        reason: begin.reason,
        ...demands.snapshot(),
      });
      rec.event("pay.declined", { endpoint, reason: begin.reason, retry_sent: false });
      return { status: "declined", reason: begin.reason };
    }

    // ---- 5d. upto: 署名の前に上限額で予約する（settle 後に実額で確定） ----
    if (isUpto(demand)) {
      reservation = limiter.reserve(demand.amountAtomic);
      rec.event("guard.limit.reserved", {
        endpoint,
        scheme: demand.scheme,
        cap_atomic: demand.amountAtomic.toString(),
        ...limiter.snapshot(),
      });
    }

    // ---- 6. 承認済み。決済証明を作る（鍵はこの内側にしか無い） ----
    const proof = await backend.processPayment(demand, { clientToken: begin.entry.clientToken });
    rec.event("pay.proof", {
      endpoint,
      rail: proof.rail,
      status: proof.status,
      outcome: proof.outcome,
      processPaymentId: proof.processPaymentId,
      proofSource: backend.kind,
    });

    // ---- 再送（回数上限あり） ----
    const resend = demands.beginResend(ledgerKey);
    if (!resend.ok) {
      rec.event("guard.retry.blocked", { endpoint, reason: resend.reason, ...demands.snapshot() });
      releaseReservation();
      return { status: "declined", reason: resend.reason };
    }

    const retry =
      proof.rail === "x402"
        ? await x402.retryWithPayment(rec, endpoint, demand, proof.payload)
        : await mpp.retryWithCredential(rec, endpoint, proof.paymentCredential);

    if (retry.status === 402) {
      // 402 が返り続けるとき、署名し直して投げ直さない。
      // 同じ金額を二度払う事故は、ここで止めるのが一番安い。
      rec.event("pay.resend_rejected", {
        endpoint,
        status: retry.status,
        note: "売り手が支払いを受け付けなかった。再署名はしない。",
        body: retry.bodyText.slice(0, 300),
      });
      releaseReservation();
      return { status: "declined", reason: "payment_rejected_by_merchant" };
    }
    if (retry.status < 200 || retry.status >= 300) {
      rec.event("pay.retry_failed", { endpoint, status: retry.status, body: retry.bodyText.slice(0, 400) });
      releaseReservation();
      return { status: "error", reason: `retry_status_${retry.status}` };
    }

    // ---- 7. 200/success と receipt ----
    const merchant = deps.merchantKind(endpoint);
    const receiptMeta = {
      proofSource: backend.kind,
      merchant,
      paymentStatus: proof.status,
      approval: approvalForReceipt,
    } as const;
    const receipt =
      proof.rail === "x402"
        ? x402.receiptFrom(retry, demand, receiptMeta)
        : mpp.receiptFrom(retry, demand, receiptMeta);

    if (reservation) {
      // 実額が売り手から返らなければ上限額で確定する（少なく見積もらない）。
      const actual = receipt.settledAmount !== undefined ? BigInt(receipt.settledAmount) : demand.amountAtomic;
      const r = limiter.settle(reservation, actual);
      reservation = undefined;
      rec.event("guard.limit.settled", {
        endpoint,
        scheme: demand.scheme,
        cap_atomic: demand.amountAtomic.toString(),
        actual_atomic: actual.toString(),
        actual_source: receipt.settledAmount !== undefined ? "merchant-settlement" : "cap (settlement に額が無い)",
        released_atomic: r.released.toString(),
        ...(r.overcharge > 0n ? { overcharge_atomic: r.overcharge.toString(), note: "売り手が上限額を超えて請求した" } : {}),
        ...limiter.snapshot(),
      });
    } else {
      limiter.commit(demand.amountAtomic);
    }
    const settledCount = demands.markSettled(ledgerKey, fingerprint);
    if (settledCount > 1) {
      // 止めはしない（同じ商品の再購入は正当）。気づけるようにだけしておく。
      rec.event("guard.duplicate.session_repeat", {
        endpoint,
        fingerprint,
        times_settled_in_session: settledCount,
        note: "経済的に同一の請求がセッション内で複数回成立した",
      });
    }
    rec.event("pay.success", { endpoint, receipt, ...limiter.snapshot() });

    return { status: "success", receipt };
  } catch (err) {
    if (reservation) {
      limiter.release(reservation);
      rec.event("guard.limit.released", { endpoint, cap_atomic: reservation.capAtomic.toString(), ...limiter.snapshot() });
      reservation = undefined;
    }
    if (err instanceof MainnetDetected) {
      // 7節「実マネー禁止フラグ」。ここに来たらセッションごと落とす。
      rec.event("guard.mainnet.detected", { endpoint, where: err.where, value: err.value });
      throw err;
    }
    rec.event("pay.error", { endpoint, error: (err as Error).message });
    return { status: "error", reason: (err as Error).message };
  }
}

async function askHuman(
  deps: PayDeps,
  endpoint: string,
  demand: { rail: string; amountAtomic: bigint; asset: string; network: string; payTo: string },
  reason: "first_time_endpoint" | "over_granted_amount",
  previousGrant: Grant | undefined,
): Promise<ApprovalRecord> {
  const { cfg, rec, approver } = deps;
  const amountUsd = atomicToUsd(demand.amountAtomic);
  const pointName =
    reason === "first_time_endpoint" ? "初回エンドポイントへの支払い" : "承認済み金額を超える支払い";

  if (cfg.autoApprove) {
    const record: ApprovalRecord = {
      endpoint,
      rail: demand.rail,
      amountUsd,
      asset: demand.asset,
      network: demand.network,
      payTo: demand.payTo,
      reason,
      approved: true,
      approver: "AUTO_APPROVE",
      at: new Date().toISOString(),
      mode: "auto",
    };
    rec.event("approval.point", {
      point: 1,
      name: pointName,
      endpoint,
      asked_human: false,
      approved: true,
      note: "AUTO_APPROVE=true が明示指定された（既定は false）",
    });
    return record;
  }

  const record = await approver.ask({
    endpoint,
    rail: demand.rail,
    amountUsd,
    asset: demand.asset,
    network: demand.network,
    payTo: demand.payTo,
    reason,
  });
  rec.event("approval.point", {
    point: 1,
    name: pointName,
    endpoint,
    asked_human: true,
    approved: record.approved,
    approver: record.approver,
    at: record.at,
    amount_usd: record.amountUsd,
    ...(previousGrant
      ? { previous_scope: ApprovalLedger.describe(previousGrant) }
      : {}),
  });
  return record;
}

function guessRail(endpoint: string): Rail {
  return endpoint.includes("/mpp") ? "mpp" : "x402";
}

function isUpto(demand: { rail: Rail; scheme: string }): boolean {
  return demand.rail === "x402" && demand.scheme.toLowerCase() === "upto";
}

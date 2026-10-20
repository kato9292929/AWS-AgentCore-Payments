import { assertTestnetNetwork } from "../guard/network.js";
import type { Recorder } from "../log/recorder.js";
import type { AcceptSummary, PaymentDemand, Receipt, X402Raw } from "../types.js";
import { b64decode, b64encode, recordedFetch, type RoundTrip } from "./http.js";

/**
 * x402 レール。
 * 仕様: coinbase/x402 specs/x402-specification-v1.md + specs/transports-v1/http.md
 *  - 402 body: { x402Version, error, accepts: [PaymentRequirements] }
 *  - 再送: X-PAYMENT ヘッダに base64(JSON PaymentPayload)
 *  - 成功: X-PAYMENT-RESPONSE ヘッダに base64(JSON SettlementResponse)
 *
 * v2（specs/transports-v2/http.md）。読み方は bedrock-agentcore 1.24.2 の
 * PaymentManager._extract_x402_payload / _build_payment_header に揃えてある:
 *  - 402: PAYMENT-REQUIRED ヘッダに base64(JSON { x402Version: 2, resource, accepts }) 。
 *         accepts[].network は CAIP-2、金額は amount（v1 の maxAmountRequired に当たる）
 *  - 再送: PAYMENT-SIGNATURE ヘッダに base64(JSON { x402Version: 2, resource, accepted, extensions, payload })
 *  - 成功: PAYMENT-RESPONSE ヘッダに base64(JSON SettlementResponse)
 */

export interface X402Requirements {
  scheme: string;
  network: string;
  /** v1 の金額。upto では上限額。 */
  maxAmountRequired?: string;
  /** v2 の金額。upto では上限額。 */
  amount?: string;
  asset: string;
  payTo: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

/** v1 / v2 の差を吸収して金額（atomic 文字列）を取る。どちらも無ければ停止。 */
export function amountOf(a: X402Requirements): string {
  const v = a.amount ?? a.maxAmountRequired;
  if (v === undefined || !/^\d+$/.test(String(v))) {
    throw new Error(`x402: accept に金額が無い／不正（amount=${a.amount}, maxAmountRequired=${a.maxAmountRequired}）`);
  }
  return String(v);
}

/** 402 から x402 の支払い要求本体を取り出す。v2 ヘッダを優先し、無ければ v1 body。 */
export function extract402(trip: RoundTrip): {
  body: { x402Version: number; accepts: X402Requirements[]; resource?: unknown; extensions?: unknown };
  transport: "v1-body" | "v2-header";
} {
  const header = trip.headers["payment-required"];
  if (header) {
    return { body: b64decode(header) as never, transport: "v2-header" };
  }
  return { body: JSON.parse(trip.bodyText) as never, transport: "v1-body" };
}

export function parse402(trip: RoundTrip): { demand: PaymentDemand; accepts: AcceptSummary[] } {
  const { body, transport } = extract402(trip);
  if (!Array.isArray(body.accepts) || body.accepts.length === 0) {
    throw new Error("x402: 402 応答に accepts が無い");
  }

  const accepts: AcceptSummary[] = body.accepts.map((a) => ({
    scheme: a.scheme,
    network: a.network,
    asset: a.asset,
    payTo: a.payTo,
    maxAmountRequired: a.amount ?? a.maxAmountRequired ?? "",
  }));

  // testnet の選択肢だけを候補にする。mainnet しか無ければここで停止する。
  const chosen = body.accepts.find((a) => {
    try {
      assertTestnetNetwork(a.network);
      return true;
    } catch {
      return false;
    }
  });
  if (!chosen) {
    // 全部 mainnet なら MainnetDetected を投げさせる
    assertTestnetNetwork(body.accepts[0]!.network);
    throw new Error("x402: testnet の accepts が無い");
  }
  assertTestnetNetwork(chosen.network);

  const raw: X402Raw = {
    kind: "x402",
    x402Version: Number(body.x402Version),
    transport,
    ...(body.resource !== undefined ? { resource: body.resource } : {}),
    requirements: chosen as unknown as Record<string, unknown>,
    body: body as unknown as Record<string, unknown>,
  };

  return {
    demand: {
      rail: "x402",
      scheme: chosen.scheme,
      network: chosen.network,
      amountAtomic: BigInt(amountOf(chosen)),
      asset: chosen.asset,
      payTo: chosen.payTo,
      raw,
    },
    accepts,
  };
}

/** 素のリクエスト（支払いヘッダ無し）。402 を受けるのが正常系。 */
export async function probe(rec: Recorder, endpoint: string): Promise<RoundTrip> {
  return recordedFetch(rec, "x402.bare-request", endpoint);
}

/**
 * 証明（AgentCore / local-signer が返した payload）を載せて再送する。
 * v1 は X-PAYMENT、v2 は PAYMENT-SIGNATURE。組み立ては SDK の _build_payment_header と同じ形。
 */
export async function retryWithPayment(
  rec: Recorder,
  endpoint: string,
  demand: PaymentDemand,
  payload: unknown,
): Promise<RoundTrip> {
  if (demand.raw.kind !== "x402") throw new Error("x402 の demand ではない");
  const raw = demand.raw;
  if (raw.x402Version >= 2) {
    const body = raw.body as { extensions?: unknown };
    const header = b64encode({
      x402Version: raw.x402Version,
      resource: raw.resource,
      accepted: raw.requirements,
      extensions: body.extensions ?? {},
      payload,
    });
    return recordedFetch(rec, "x402.retry-with-payment", endpoint, {
      headers: { "PAYMENT-SIGNATURE": header },
    });
  }
  const header = b64encode({ x402Version: raw.x402Version, scheme: demand.scheme, network: demand.network, payload });
  return recordedFetch(rec, "x402.retry-with-payment", endpoint, {
    headers: { "X-PAYMENT": header },
  });
}

export function receiptFrom(
  trip: RoundTrip,
  demand: PaymentDemand,
  meta: {
    proofSource: Receipt["proofSource"];
    merchant: Receipt["merchant"];
    paymentStatus: string;
    approval: Receipt["approval"];
  },
): Receipt {
  const raw = trip.headers["payment-response"] ?? trip.headers["x-payment-response"];
  let reference = "";
  let network = demand.network;
  let settledAmount: string | undefined;
  if (raw) {
    const settle = b64decode(raw) as {
      success: boolean;
      transaction: string;
      network: string;
      payer: string;
      /** upto: 実際に決済した額。exact の売り手は返さないことがある。 */
      amount?: string;
    };
    reference = settle.transaction;
    network = settle.network ?? network;
    if (settle.amount !== undefined && /^\d+$/.test(String(settle.amount))) settledAmount = String(settle.amount);
  }
  if (settledAmount === undefined && demand.scheme === "exact" && reference) {
    settledAmount = demand.amountAtomic.toString();
  }
  return {
    reference,
    amount: demand.amountAtomic.toString(),
    asset: demand.asset,
    network,
    payTo: demand.payTo,
    rail: "x402",
    scheme: demand.scheme,
    ...(settledAmount !== undefined ? { settledAmount } : {}),
    timestamp: new Date().toISOString(),
    proofSource: meta.proofSource,
    paymentStatus: meta.paymentStatus,
    // 売り手が受領ヘッダを返したときだけ「確定」を名乗る
    settlementConfirmedBy: reference ? "merchant-receipt" : "none",
    testnet: true,
    merchant: meta.merchant,
    approval: meta.approval,
  };
}

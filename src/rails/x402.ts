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
 */

export interface X402Requirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  asset: string;
  payTo: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export function parse402(trip: RoundTrip): { demand: PaymentDemand; accepts: AcceptSummary[] } {
  const body = JSON.parse(trip.bodyText) as {
    x402Version: number;
    accepts: X402Requirements[];
  };
  if (!Array.isArray(body.accepts) || body.accepts.length === 0) {
    throw new Error("x402: 402 応答に accepts が無い");
  }

  const accepts: AcceptSummary[] = body.accepts.map((a) => ({
    scheme: a.scheme,
    network: a.network,
    asset: a.asset,
    payTo: a.payTo,
    maxAmountRequired: a.maxAmountRequired,
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
    x402Version: body.x402Version,
    requirements: chosen as unknown as Record<string, unknown>,
    body: body as unknown as Record<string, unknown>,
  };

  return {
    demand: {
      rail: "x402",
      scheme: chosen.scheme,
      network: chosen.network,
      amountAtomic: BigInt(chosen.maxAmountRequired),
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

/** AgentCore が返した x402 payload を X-PAYMENT ヘッダに載せて再送する。 */
export async function retryWithPayment(
  rec: Recorder,
  endpoint: string,
  x402Version: number,
  scheme: string,
  network: string,
  payload: unknown,
): Promise<RoundTrip> {
  const header = b64encode({ x402Version, scheme, network, payload });
  return recordedFetch(rec, "x402.retry-with-payment", endpoint, {
    headers: { "X-PAYMENT": header },
  });
}

export function receiptFrom(
  trip: RoundTrip,
  demand: PaymentDemand,
  proofSource: Receipt["proofSource"],
  merchant: Receipt["merchant"],
): Receipt {
  const raw = trip.headers["x-payment-response"];
  let reference = "";
  let network = demand.network;
  if (raw) {
    const settle = b64decode(raw) as {
      success: boolean;
      transaction: string;
      network: string;
      payer: string;
    };
    reference = settle.transaction;
    network = settle.network ?? network;
  }
  return {
    reference,
    amount: demand.amountAtomic.toString(),
    asset: demand.asset,
    network,
    payTo: demand.payTo,
    rail: "x402",
    timestamp: new Date().toISOString(),
    proofSource,
    testnet: true,
    merchant,
  };
}

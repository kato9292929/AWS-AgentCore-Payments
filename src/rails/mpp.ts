import { assertTestnetChainId } from "../guard/network.js";
import type { Recorder } from "../log/recorder.js";
import type { AcceptSummary, MppRaw, PaymentDemand, Receipt } from "../types.js";
import { b64urlDecode, recordedFetch, type RoundTrip } from "./http.js";

/**
 * MPP（Machine Payments Protocol）レール。
 * 仕様: tempoxyz/mpp-specs specs/core/draft-httpauth-payment-00.md
 *       + specs/methods/evm/draft-evm-charge-00.md
 *  - 402 + `WWW-Authenticate: Payment id=.., realm=.., method=.., intent=.., request=..`
 *  - 再送: `Authorization: Payment <base64url(credential)>`
 *  - 成功: `Payment-Receipt: <base64url({status, method, timestamp, reference})>`
 *
 * x402 との差分（ログに併記する点）:
 *  - 支払い要求が body JSON ではなく HTTP 認証ヘッダに載る
 *  - 金額は base64url(JCS JSON) の `request` パラメータの中にある
 *  - チェーンは network 文字列ではなく methodDetails.chainId（EIP-155）
 *  - レシートが専用ヘッダ Payment-Receipt で返る
 */

export interface MppChallenge {
  raw: string;
  params: Record<string, string>;
  request: {
    amount: string;
    currency: string;
    recipient: string;
    description?: string;
    methodDetails?: { chainId?: number; credentialTypes?: string[]; decimals?: number };
  };
}

/** RFC 9110 の auth-param 列をパースする（Payment スキームのみ扱う）。 */
export function parseChallenges(headerValue: string): MppChallenge[] {
  const out: MppChallenge[] = [];
  // 複数チャレンジは "Payment ..., Payment ..." の形で連結される
  const chunks = headerValue
    .split(/,\s*(?=Payment\s)/i)
    .map((s) => s.trim())
    .filter((s) => /^Payment\b/i.test(s));

  for (const chunk of chunks) {
    const paramText = chunk.replace(/^Payment\s*/i, "");
    const params: Record<string, string> = {};
    const re = /([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(paramText)) !== null) {
      params[m[1]!] = m[2] ?? m[3] ?? "";
    }
    if (!params["id"]) continue; // id 必須。無いチャレンジは仕様上 reject
    const requestB64 = params["request"];
    if (!requestB64) continue;
    out.push({
      raw: chunk,
      params,
      request: b64urlDecode(requestB64) as MppChallenge["request"],
    });
  }
  return out;
}

export function parse402(trip: RoundTrip): { demand: PaymentDemand; accepts: AcceptSummary[] } {
  const header = trip.headers["www-authenticate"];
  if (!header) throw new Error("mpp: 402 に WWW-Authenticate ヘッダが無い");

  const challenges = parseChallenges(header);
  if (challenges.length === 0) throw new Error("mpp: Payment チャレンジを解釈できない");

  const accepts: AcceptSummary[] = challenges.map((c) => ({
    scheme: `${c.params["method"] ?? "?"}/${c.params["intent"] ?? "?"}`,
    network: chainLabel(c),
    asset: c.request.currency,
    payTo: c.request.recipient,
    maxAmountRequired: c.request.amount,
  }));

  // charge intent の testnet チャレンジを 1 件選ぶ
  const chosen =
    challenges.find((c) => {
      if ((c.params["intent"] ?? "charge") !== "charge") return false;
      const id = c.request.methodDetails?.chainId;
      if (id === undefined) return false;
      try {
        assertTestnetChainId(id);
        return true;
      } catch {
        return false;
      }
    }) ?? challenges[0]!;

  const chainId = chosen.request.methodDetails?.chainId;
  if (chainId === undefined) throw new Error("mpp: methodDetails.chainId が無い（chain 不明のため停止）");
  assertTestnetChainId(chainId);

  const raw: MppRaw = {
    kind: "mpp",
    wwwAuthenticate: chosen.raw,
    challenge: chosen.params,
    request: chosen.request as unknown as Record<string, unknown>,
  };

  return {
    demand: {
      rail: "mpp",
      scheme: `${chosen.params["method"]}/${chosen.params["intent"] ?? "charge"}`,
      network: chainLabel(chosen),
      amountAtomic: BigInt(chosen.request.amount),
      asset: chosen.request.currency,
      payTo: chosen.request.recipient,
      raw,
    },
    accepts,
  };
}

function chainLabel(c: MppChallenge): string {
  const id = c.request.methodDetails?.chainId;
  const known: Record<number, string> = {
    84532: "base-sepolia",
    11155111: "ethereum-sepolia",
    43113: "avalanche-fuji",
  };
  return id === undefined ? "unknown" : (known[id] ?? `eip155:${id}`);
}

export async function probe(rec: Recorder, endpoint: string): Promise<RoundTrip> {
  return recordedFetch(rec, "mpp.bare-request", endpoint, {
    // 対応する支払い方式を宣言する（core spec の Accept-Payment）
    headers: { "Accept-Payment": "evm/charge, usdc/charge" },
  });
}

/** AgentCore が返した paymentCredential（"Payment <token>" 形）をそのまま載せて再送。 */
export async function retryWithCredential(
  rec: Recorder,
  endpoint: string,
  authorizationHeaderValue: string,
): Promise<RoundTrip> {
  return recordedFetch(rec, "mpp.retry-with-credential", endpoint, {
    headers: { Authorization: authorizationHeaderValue },
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
  const raw = trip.headers["payment-receipt"];
  let reference = "";
  let timestamp = new Date().toISOString();
  if (raw) {
    const r = b64urlDecode(raw) as { status: string; method: string; timestamp: string; reference: string };
    reference = r.reference;
    timestamp = r.timestamp ?? timestamp;
  }
  return {
    reference,
    amount: demand.amountAtomic.toString(),
    asset: demand.asset,
    network: demand.network,
    payTo: demand.payTo,
    rail: "mpp",
    timestamp,
    proofSource: meta.proofSource,
    paymentStatus: meta.paymentStatus,
    // 売り手が受領ヘッダを返したときだけ「確定」を名乗る
    settlementConfirmedBy: reference ? "merchant-receipt" : "none",
    testnet: true,
    merchant: meta.merchant,
    approval: meta.approval,
  };
}

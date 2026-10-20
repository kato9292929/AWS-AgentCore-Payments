import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { atomicToUsd } from "../config.js";
import { assertTestnetChainId, assertTestnetNetwork } from "../guard/network.js";
import type { Recorder } from "../log/recorder.js";
import { parseChallenges } from "../rails/mpp.js";
import { recordedFetch, type RoundTrip } from "../rails/http.js";
import { extract402, type X402Requirements } from "../rails/x402.js";

/**
 * --probe-only（AC-4）。
 *
 * 売り手の 402 を取って payTo・価格・scheme・network を記録するだけ。
 * 署名・ProcessPayment・再送は一切しない。backend も開かない。
 * mainnet の提示も「記録する」だけで停止しない（何も署名しないので実マネーは動かない）。
 */

export interface ProbeTarget {
  label?: string;
  /** 比較表で使う売り手名（同じ売り手の複数エンドポイントを束ねる） */
  seller?: string;
  /** null はホスト未特定（記録だけ残す） */
  url: string | null;
  note?: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ProbedAccept {
  protocol: "x402" | "MPP";
  x402Version?: number;
  scheme: string;
  network: string;
  /** testnet と確認できたか。できなければ mainnet か不明（どちらでも署名はしない）。 */
  networkClass: "testnet" | "mainnet-or-unknown";
  amountAtomic: string;
  priceUsd: string | null;
  asset: string;
  payTo: string;
  extra?: unknown;
}

export interface ProbeResult {
  label: string;
  seller?: string;
  url: string;
  host: string;
  method: string;
  httpStatus: number | null;
  latencyMs: number | null;
  probedAt: string;
  accepts: ProbedAccept[];
  error?: string;
}

/** 既知の USDC（6 decimals）。それ以外の asset は USD 換算しない。 */
const USDC_6: Record<string, true> = {
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e": true, // Base Sepolia
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": true, // Base
  "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": true, // Ethereum Sepolia
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": true, // Ethereum
  "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v": true, // Solana USDC
  "4zmmc9srt5ri5x14gagxhahii3gnpaeerypjgzjdncdu": true, // Solana devnet USDC
};

function priceUsd(asset: string, amountAtomic: string, extra: unknown): string | null {
  if (!/^\d+$/.test(amountAtomic)) return null;
  const decimals = (extra as { decimals?: number } | undefined)?.decimals;
  if (USDC_6[asset.toLowerCase()] || decimals === 6) return atomicToUsd(BigInt(amountAtomic));
  return null;
}

function classify(network: string): ProbedAccept["networkClass"] {
  try {
    assertTestnetNetwork(network);
    return "testnet";
  } catch {
    return "mainnet-or-unknown";
  }
}

export function acceptsFrom(trip: RoundTrip): ProbedAccept[] {
  const out: ProbedAccept[] = [];
  if (trip.status !== 402) return out;

  // x402（v2 ヘッダ / v1 body）
  try {
    const { body } = extract402(trip);
    for (const a of (body.accepts ?? []) as X402Requirements[]) {
      const amount = String(a.amount ?? a.maxAmountRequired ?? "");
      out.push({
        protocol: "x402",
        x402Version: Number(body.x402Version),
        scheme: a.scheme,
        network: a.network,
        networkClass: classify(a.network),
        amountAtomic: amount,
        priceUsd: priceUsd(a.asset ?? "", amount, a.extra),
        asset: a.asset,
        payTo: a.payTo,
        ...(a.extra !== undefined ? { extra: a.extra } : {}),
      });
    }
  } catch {
    /* x402 ではない */
  }

  // MPP（WWW-Authenticate: Payment ...）
  const www = trip.headers["www-authenticate"];
  if (www && /Payment\s/i.test(www)) {
    for (const c of parseChallenges(www)) {
      const chainId = c.request.methodDetails?.chainId;
      let networkClass: ProbedAccept["networkClass"] = "mainnet-or-unknown";
      if (chainId !== undefined) {
        try {
          assertTestnetChainId(chainId);
          networkClass = "testnet";
        } catch {
          /* mainnet か不明 */
        }
      }
      out.push({
        protocol: "MPP",
        scheme: `${c.params["method"] ?? "?"}/${c.params["intent"] ?? "?"}`,
        network: chainId !== undefined ? `eip155:${chainId}` : (c.params["method"] ?? "unknown"),
        networkClass,
        amountAtomic: c.request.amount,
        priceUsd: priceUsd(c.request.currency ?? "", c.request.amount, c.request.methodDetails),
        asset: c.request.currency,
        payTo: c.request.recipient,
        extra: { methodDetails: c.request.methodDetails, expires: c.params["expires"] },
      });
    }
  }
  return out;
}

export async function probeOne(rec: Recorder, t: ProbeTarget): Promise<ProbeResult> {
  const method = (t.method ?? "GET").toUpperCase();
  const probedAt = new Date().toISOString();
  if (!t.url) {
    const result: ProbeResult = {
      label: t.label ?? "unknown",
      ...(t.seller ? { seller: t.seller } : {}),
      url: "",
      host: "",
      method,
      httpStatus: null,
      latencyMs: null,
      probedAt,
      accepts: [],
      error: t.note ?? "url 未設定",
    };
    rec.event("probe.result", { ...result, signed: false });
    return result;
  }
  const url = t.url;
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  const started = Date.now();
  try {
    const trip = await recordedFetch(rec, "probe.bare-request", url, {
      method,
      headers: {
        ...(t.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(t.headers ?? {}),
      },
      ...(t.body !== undefined ? { body: JSON.stringify(t.body) } : {}),
    });
    const accepts = acceptsFrom(trip);
    const result: ProbeResult = {
      label: t.label ?? host,
      ...(t.seller ? { seller: t.seller } : {}),
      url,
      host,
      method,
      httpStatus: trip.status,
      latencyMs: Date.now() - started,
      probedAt,
      accepts,
    };
    rec.event("probe.result", { ...result, signed: false });
    return result;
  } catch (err) {
    const result: ProbeResult = {
      label: t.label ?? host,
      ...(t.seller ? { seller: t.seller } : {}),
      url,
      host,
      method,
      httpStatus: null,
      latencyMs: null,
      probedAt,
      accepts: [],
      error: (err as Error).message,
    };
    rec.event("probe.result", { ...result, signed: false });
    return result;
  }
}

/** URL 文字列か、config/probe-targets.json 形式のファイル（@path）を受ける。 */
export async function probeEndpoints(rec: Recorder, targets: string[]): Promise<ProbeResult[]> {
  const expanded: ProbeTarget[] = [];
  for (const t of targets) {
    if (t.startsWith("@")) {
      const file = JSON.parse(readFileSync(resolve(t.slice(1)), "utf8")) as { targets: ProbeTarget[] };
      expanded.push(...file.targets);
    } else {
      expanded.push({ url: t });
    }
  }
  const out: ProbeResult[] = [];
  for (const t of expanded) out.push(await probeOne(rec, t));
  return out;
}

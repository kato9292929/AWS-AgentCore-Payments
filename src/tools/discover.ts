import { readFileSync } from "node:fs";
import { atomicToUsd } from "../config.js";
import { MainnetDetected } from "../guard/network.js";
import type { Recorder } from "../log/recorder.js";
import * as mpp from "../rails/mpp.js";
import * as x402 from "../rails/x402.js";
import type { Candidate, Rail } from "../types.js";

interface RegistryEntry {
  id: string;
  rail: Rail;
  endpoint: string;
  description: string;
  statedPrice: string;
  kind: "live" | "mock-local";
  reachability: "ok" | "unverified";
}

export interface DiscoverOptions {
  registryPath: string;
  /** live エンドポイントを実際に叩くか。既定は false（mock のみ）。 */
  allowLive: boolean;
  /** 外部ディレクトリ（x402 Bazaar / MPP discovery）の URL。設定時はこちらを優先。 */
  directoryUrl?: string | undefined;
}

/**
 * ツール1: discover(query)
 *
 * 役割: 課金エンドポイントを探す。402 のヒントや MPP/x402 のディレクトリを引く。
 * モデルに返すもの: 候補一覧（price と rail を含む）。鍵・署名は含めない。
 */
export async function discover(
  rec: Recorder,
  query: string,
  opts: DiscoverOptions,
): Promise<Candidate[]> {
  rec.event("tool.discover.call", { query, allowLive: opts.allowLive, directoryUrl: opts.directoryUrl });

  const entries = await loadEntries(rec, opts);
  const q = query.trim().toLowerCase();
  const matched = entries.filter((e) => {
    if (!opts.allowLive && e.kind === "live") return false;
    if (q === "" || q === "*") return true;
    return (
      e.rail.includes(q) ||
      e.id.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.endpoint.toLowerCase().includes(q)
    );
  });

  const candidates: Candidate[] = [];
  for (const e of matched) {
    // 402 を実際に叩いて価格とレールを確認する。これが取れた候補だけ
    // priceSource: "402-probe" になる。
    try {
      const trip =
        e.rail === "x402" ? await x402.probe(rec, e.endpoint) : await mpp.probe(rec, e.endpoint);
      if (trip.status === 402) {
        const parsed = e.rail === "x402" ? x402.parse402(trip) : mpp.parse402(trip);
        candidates.push({
          endpoint: e.endpoint,
          price: atomicToUsd(parsed.demand.amountAtomic),
          priceAtomic: parsed.demand.amountAtomic.toString(),
          rail: e.rail,
          accepts: parsed.accepts,
          description: e.description,
          priceSource: "402-probe",
        });
        continue;
      }
      rec.event("discover.probe.unexpected_status", { endpoint: e.endpoint, status: trip.status });
    } catch (err) {
      if (err instanceof MainnetDetected) throw err; // 実マネー検出は握り潰さない
      rec.event("discover.probe.failed", {
        endpoint: e.endpoint,
        error: (err as Error).message,
        note: "402 ヒントが取れないため statedPrice を使う（priceSource: directory）",
      });
    }
    candidates.push({
      endpoint: e.endpoint,
      price: e.statedPrice,
      priceAtomic: "unknown",
      rail: e.rail,
      accepts: [],
      description: e.description,
      priceSource: "directory",
    });
  }

  rec.event("tool.discover.result", {
    count: candidates.length,
    candidates: candidates.map((c) => ({
      endpoint: c.endpoint,
      price: c.price,
      rail: c.rail,
      priceSource: c.priceSource,
    })),
  });
  return candidates;
}

async function loadEntries(rec: Recorder, opts: DiscoverOptions): Promise<RegistryEntry[]> {
  if (opts.directoryUrl) {
    try {
      const res = await fetch(opts.directoryUrl);
      const body = (await res.json()) as { endpoints: RegistryEntry[] };
      rec.event("discover.directory.loaded", { url: opts.directoryUrl, count: body.endpoints.length });
      return body.endpoints;
    } catch (err) {
      rec.event("discover.directory.failed", {
        url: opts.directoryUrl,
        error: (err as Error).message,
        note: "ローカルレジストリにフォールバック",
      });
    }
  }
  const file = JSON.parse(readFileSync(opts.registryPath, "utf8")) as { endpoints: RegistryEntry[] };
  return file.endpoints;
}

/**
 * AC-4: AC-2・AC-3・--probe-only のログを docs/AC4-schema.md の書式（1 支払い試行 = 1 行）に揃える。
 *
 * 入力（あるものだけ読む。無ければ飛ばす）:
 *   artifacts/ac2/runs.jsonl            … AC-2 の 402→200（scripts/ac2/run.py）
 *   artifacts/ac3/live.json             … AC-3a の live（scripts/ac3/run.ts --mode=live）
 *   artifacts/ac3/blockrun-mainnet.json … AC-3b（scripts/ac3/blockrun_mainnet.py）
 *   artifacts/ac4/probe/probe.json      … --probe-only（支払っていない。price だけが埋まる）
 *
 * 出力:
 *   artifacts/ac4/normalized.jsonl / normalized.csv
 *   artifacts/ac4/comparison.md         … 売り手ごとの AgentCore 列と、空欄の AA 列
 *
 * AA（x402 Autonomous Agent）側のデータ取得はこのリポジトリの範囲外。AA 列は空欄で出す。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface Row {
  timestamp: string; // JST, ISO 8601 +09:00
  seller_host: string;
  protocol: "x402" | "MPP";
  scheme: string;
  network: string;
  price: string | null; // USD（402 の提示額。upto は上限額）
  settled_amount: string | null; // USD（実際に決済された額）
  gas: string | null; // 買い手が負担したガス（ネイティブトークン建て）。facilitator 負担なら "0"
  latency_ms: number | null; // 402 受信 → 200 受信
  http_status: number | null; // 最終応答
  delivered: boolean; // 200 系で中身を受け取れたか
  processPaymentId: string | null;
  tx_hash: string | null;
  // ---- ここから書式の外（取り違え防止の付帯情報） ----
  source: string;
  /** agentcore: 本物の ProcessPayment / local-fake: AgentCore を呼ばない自己確認 / probe-only: 支払っていない */
  path: "agentcore" | "local-fake" | "probe-only";
}

const COLUMNS: Array<keyof Row> = [
  "timestamp",
  "seller_host",
  "protocol",
  "scheme",
  "network",
  "price",
  "settled_amount",
  "gas",
  "latency_ms",
  "http_status",
  "delivered",
  "processPaymentId",
  "tx_hash",
  "source",
  "path",
];

export function toJst(iso: string | number | undefined): string {
  const t = typeof iso === "number" ? iso : iso ? Date.parse(iso) : Date.now();
  const d = new Date(t + 9 * 3600_000);
  return d.toISOString().replace(/\.\d{3}Z$/, "+09:00");
}

/** atomic（USDC 6 decimals）→ USD 文字列。数字でなければ null。 */
export function usd(atomic: unknown): string | null {
  if (atomic === undefined || atomic === null || !/^\d+$/.test(String(atomic))) return null;
  const a = BigInt(String(atomic));
  return `${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, "0")}`;
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function readJson(path: string): unknown {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

// ---------------------------------------------------------------- 変換

export function fromAc2(lines: Array<Record<string, any>>): Row[] {
  return lines.map((r) => {
    const pp = (r["process_payment"] ?? [])[0] ?? {};
    const st = r["settlement"] ?? {};
    const kept = r["payto_guard"]?.["kept"]?.[0] ?? {};
    return {
      timestamp: r["timestamp_jst"] ?? toJst(undefined),
      seller_host: host(r["url"]),
      protocol: r["protocol"] === "MPP" ? "MPP" : "x402",
      scheme: pp["payload_summary"]?.["scheme"] ?? kept["scheme"] ?? "exact",
      network: pp["payload_summary"]?.["network"] ?? kept["network"] ?? "",
      price: usd(pp["payload_summary"]?.["amount"]),
      settled_amount: usd(st["amount"] ?? r["onchain"]?.["usdc_transfers"]?.[0]?.["amount_atomic"]),
      gas: r["delivered"] ? "0" : null, // x402 exact / EIP-3009 は facilitator がガスを払う
      latency_ms: r["latency_ms"] ?? null,
      http_status: r["http_status"] ?? r["first_status"] ?? null,
      delivered: Boolean(r["delivered"]),
      processPaymentId: pp["process_payment_id"] ?? null,
      tx_hash: st["transaction"] ?? st["reference"] ?? null,
      source: "artifacts/ac2/runs.jsonl",
      path: r["plane"] === "local" ? "local-fake" : "agentcore",
    };
  });
}

export function fromAc3Live(d: Record<string, any> | undefined): Row[] {
  if (!d?.["executed"]) return [];
  return (d["calls"] as Array<Record<string, any>>).map((c) => ({
    timestamp: toJst(d["measuredAt"]),
    seller_host: "127.0.0.1 (mock-local, facilitator settle)",
    protocol: "x402",
    scheme: "upto",
    network: c["settlement"]?.["network"] ?? "eip155:84532",
    price: d["cap_usd"] ?? null,
    settled_amount: usd(c["settlement"]?.["amount"]),
    gas: c["i"] === 1 ? (d["approve_gas_eth"] ?? null) : "0",
    latency_ms: null,
    http_status: c["resend_status"] ?? null,
    delivered: c["resend_status"] >= 200 && c["resend_status"] < 300,
    processPaymentId: c["processPaymentId"] ?? null,
    tx_hash: c["settlement"]?.["transaction"] || null,
    source: "artifacts/ac3/live.json",
    path: "agentcore",
  }));
}

export function fromAc3b(d: Record<string, any> | undefined): Row[] {
  if (!d?.["paid"]) return [];
  return (d["runs"] as Array<Record<string, any>>).map((r) => {
    const pp = (d["process_payment"] ?? [])[r["i"] - 1] ?? {};
    return {
      timestamp: toJst(d["measuredAt"]),
      seller_host: host(d["seller"]),
      protocol: "x402",
      scheme: r["scheme"],
      network: "eip155:8453",
      price: r["cap_usd"] ?? null,
      settled_amount: null,
      gas: null,
      latency_ms: r["latency_ms"] ?? null,
      http_status: r["http_status"] ?? null,
      delivered: r["http_status"] >= 200 && r["http_status"] < 300,
      processPaymentId: pp["process_payment_id"] ?? null,
      tx_hash: null,
      source: "artifacts/ac3/blockrun-mainnet.json",
      path: "agentcore",
    };
  });
}

export function fromProbe(d: Record<string, any> | undefined): Row[] {
  if (!d) return [];
  const rows: Row[] = [];
  for (const r of d["results"] as Array<Record<string, any>>) {
    for (const a of r["accepts"] as Array<Record<string, any>>) {
      rows.push({
        timestamp: toJst(r["probedAt"]),
        seller_host: r["host"],
        protocol: a["protocol"],
        scheme: a["scheme"],
        network: a["network"],
        price: a["priceUsd"],
        settled_amount: null,
        gas: null,
        latency_ms: null,
        http_status: r["httpStatus"],
        delivered: false,
        processPaymentId: null,
        tx_hash: null,
        source: "artifacts/ac4/probe/probe.json",
        path: "probe-only",
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------- 比較表

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function comparison(rows: Row[], probes: Record<string, any> | undefined): string {
  // 売り手ごとに束ねる。probe の seller 名を優先し、無ければ host。
  const sellerOf = new Map<string, string>();
  for (const r of (probes?.["results"] ?? []) as Array<Record<string, any>>) {
    if (r["host"]) sellerOf.set(r["host"], r["seller"] ?? r["label"]);
  }
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = sellerOf.get(r.seller_host) ?? r.seller_host;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const lines: string[] = [];
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)));
  const W = [22, 12, 40, 16, 10, 8, 12, 4];
  const head = ["売り手", "経路", "提示額 USD(scheme)", "実費 USD(中央値)", "上乗せ", "失敗率", "遅延ms(中央)", "AA"];
  lines.push(head.map((h, i) => pad(h, W[i]!)).join(" "));
  lines.push(W.map((w) => "-".repeat(w)).join(" "));
  // 402 が取れなかった売り手（ホスト未特定・到達不可）も行として残す
  for (const r of (probes?.["results"] ?? []) as Array<Record<string, any>>) {
    const k = r["seller"] ?? r["label"];
    if (!groups.has(k)) {
      lines.push(
        [k, "probe-only", r["error"] ? `(${String(r["error"]).slice(0, 30)})` : `HTTP ${r["httpStatus"]}`, "-", "-", "-", "-", ""]
          .map((c, i) => pad(c, W[i]!))
          .join(" "),
      );
    }
  }
  for (const [seller, rs] of [...groups.entries()].sort()) {
    const paid = rs.filter((r) => r.path !== "probe-only");
    const probe = rs.filter((r) => r.path === "probe-only");
    const offered = [...new Set(probe.concat(paid).map((r) => `${r.price ?? "?"}(${r.scheme})`))].slice(0, 2).join(",");
    if (paid.length === 0) {
      lines.push(
        [seller, "probe-only", offered, "未払い", "-", "-", "-", ""].map((c, i) => pad(c, W[i]!)).join(" "),
      );
      continue;
    }
    const ok = paid.filter((r) => r.delivered);
    const settled = ok.map((r) => Number(r.settled_amount)).filter((x) => Number.isFinite(x));
    const priced = ok.map((r) => Number(r.price)).filter((x) => Number.isFinite(x));
    const actual = median(settled);
    const markup = actual !== null && priced.length ? (actual - (median(priced) ?? 0)).toFixed(6) : "-";
    lines.push(
      [
        seller,
        paid.some((r) => r.path === "local-fake") ? "local-fake" : "AgentCore",
        offered,
        actual === null ? "-" : actual.toFixed(6),
        markup,
        `${paid.length - ok.length}/${paid.length}`,
        String(median(ok.map((r) => r.latency_ms ?? NaN).filter((x) => Number.isFinite(x))) ?? "-"),
        "",
      ]
        .map((c, i) => pad(c, W[i]!))
        .join(" "),
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- main

function main(): void {
  const root = resolve(process.argv.find((a) => a.startsWith("--root="))?.slice(7) ?? "artifacts");
  const out = resolve(root, "ac4");
  const ac2Path = resolve(root, "ac2/runs.jsonl");
  const ac2 = existsSync(ac2Path)
    ? readFileSync(ac2Path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, any>)
    : [];
  const probes = readJson(resolve(root, "ac4/probe/probe.json")) as Record<string, any> | undefined;
  const rows = [
    ...fromAc2(ac2),
    ...fromAc3Live(readJson(resolve(root, "ac3/live.json")) as Record<string, any> | undefined),
    ...fromAc3b(readJson(resolve(root, "ac3/blockrun-mainnet.json")) as Record<string, any> | undefined),
    ...fromProbe(probes),
  ];
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, "normalized.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  const csvCell = (v: unknown) => (v === null || v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  writeFileSync(
    resolve(out, "normalized.csv"),
    [COLUMNS.join(","), ...rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n",
  );
  const table = comparison(rows, probes);
  writeFileSync(
    resolve(out, "comparison.md"),
    `# AC-4 比較表（AgentCore 経由 / AA 列は空欄）\n\n生成: ${toJst(undefined)}（scripts/ac4/normalize.ts）\n\n` +
      "```\n" +
      table +
      "\n```\n\n" +
      "- 提示額は 402 の額（upto は上限額）。実費は settle された額の中央値。上乗せ = 実費 − 提示額。\n" +
      "- probe-only の行は 402 を見ただけで支払っていない。\n" +
      "- AA 列は x402 Autonomous Agent 側のデータで埋める（このリポジトリの範囲外）。\n",
  );
  process.stdout.write(`${rows.length} 行 → ${out}/normalized.{jsonl,csv}, comparison.md\n${table}\n`);
}

if (process.argv[1]?.endsWith("normalize.ts")) main();

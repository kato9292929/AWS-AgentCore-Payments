import { maskHeaderValue } from "../guard/redact.js";
import type { Recorder } from "../log/recorder.js";

export interface RoundTrip {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/**
 * 全 HTTP 往復をログに残す。支払いヘッダは値をマスクして構造だけ残す
 * （8節「再送リクエスト（支払い署名ヘッダは値をマスクして構造だけ）」）。
 */
export async function recordedFetch(
  rec: Recorder,
  phase: string,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RoundTrip> {
  const method = init.method ?? "GET";
  const headers = init.headers ?? {};
  rec.event("http.request", {
    phase,
    method,
    url,
    headers: Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k, maskHeaderValue(k, v)]),
    ),
    hasBody: init.body !== undefined,
  });

  const res = await fetch(url, { method, headers, body: init.body });
  const bodyText = await res.text();
  const resHeaders = headersToObject(res.headers);

  rec.event("http.response", {
    phase,
    url,
    status: res.status,
    headers: Object.fromEntries(
      Object.entries(resHeaders).map(([k, v]) => [k, maskHeaderValue(k, v)]),
    ),
    // 402 の body は支払い要求そのものなので全文残す。成功 body は先頭のみ。
    body: res.status === 402 ? safeJson(bodyText) : bodyText.slice(0, 600),
  });

  return { status: res.status, headers: resHeaders, bodyText };
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 600);
  }
}

export function b64encode(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

export function b64decode(s: string): unknown {
  return JSON.parse(Buffer.from(s, "base64").toString("utf8"));
}

export function b64urlEncode(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

export function b64urlDecode(s: string): unknown {
  return JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
}

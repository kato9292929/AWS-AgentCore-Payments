/**
 * 層1（問題A：クレデンシャル露出）
 *
 * 鍵素材はハーネス内部にしか存在しない。ここは「万一混入したら落とす」ための
 * 出口側の網。ログ書き込みとモデル向け戻り値の両方がこれを通る。
 */

/** 秘密鍵・署名ヘッダとして扱うキー名（大文字小文字無視、部分一致）。 */
const SECRET_KEY_HINTS = [
  "privatekey",
  "private_key",
  "secretkey",
  "secret_key",
  "mnemonic",
  "seedphrase",
  "seed_phrase",
  "walletauthtoken",
  "bearertoken",
  "basicauthtoken",
  "authorizationsignature",
  "apikey",
  "api_key",
  "aws_secret_access_key",
];

/** 値そのものが鍵素材に見えるパターン。 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\b0x[0-9a-fA-F]{64}\b/, // 32byte hex = secp256k1 秘密鍵と同じ形
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/**
 * 32byte hex は秘密鍵と同じ形だが、tx hash・nonce・challenge digest も同じ形をしている。
 * これらは 8節で採取が必須の項目なので、フィールド名で例外にする。
 * 例外に無いフィールドに 32byte hex が現れたら鍵素材として伏せる（deny by default）。
 */
const HASH_FIELD_ALLOWLIST = new Set([
  "reference",
  "transaction",
  "transactionhash",
  "txhash",
  "tx",
  "hash",
  "blockhash",
  "nonce",
  "expectednonce",
  "digest",
  "challengehash",
]);

export const REDACTED = "[REDACTED]";

/** ヘッダ値は構造だけ残して中身を伏せる。 */
export function maskHeaderValue(name: string, value: string): string {
  const lower = name.toLowerCase();
  if (lower === "x-payment" || lower === "authorization" || lower === "x-payment-response") {
    // 構造（スキーム名と長さ）だけを残す
    const sp = value.indexOf(" ");
    const scheme = sp > 0 ? value.slice(0, sp) : "";
    const rest = sp > 0 ? value.slice(sp + 1) : value;
    return scheme
      ? `${scheme} <${rest.length} chars, masked>`
      : `<${value.length} chars, masked>`;
  }
  return value;
}

function looksSecretKeyName(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z_]/g, "");
  return SECRET_KEY_HINTS.some((h) => k.includes(h.replace(/[^a-z_]/g, "")));
}

/** 任意の JSON 値を再帰的に伏せる。 */
export function redact(value: unknown, keyName = ""): unknown {
  if (typeof value === "string") {
    if (keyName && looksSecretKeyName(keyName)) return REDACTED;
    if (HASH_FIELD_ALLOWLIST.has(keyName.toLowerCase())) return value;
    for (const p of SECRET_VALUE_PATTERNS) {
      if (p.test(value)) return REDACTED;
    }
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((v) => redact(v, keyName));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, k);
    }
    return out;
  }
  return value;
}

/**
 * 採取済みログに鍵素材が残っていないかを事後確認する（層1の受け入れ条件）。
 * 32byte hex は HASH_FIELD_ALLOWLIST のフィールドに現れる分だけ許す。
 * 戻り値は「疑わしい箇所」の一覧。空なら鍵素材の混入なし。
 */
export function findKeyMaterial(jsonLine: string): string[] {
  const hits: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonLine);
  } catch {
    return SECRET_VALUE_PATTERNS.some((p) => p.test(jsonLine)) ? ["<non-json line>"] : [];
  }
  const walk = (v: unknown, path: string, key: string): void => {
    if (typeof v === "string") {
      if (looksSecretKeyName(key)) {
        if (v !== REDACTED) hits.push(`${path}: 鍵らしいフィールドが伏せられていない`);
        return;
      }
      if (HASH_FIELD_ALLOWLIST.has(key.toLowerCase())) return;
      for (const p of SECRET_VALUE_PATTERNS) {
        if (p.test(v)) hits.push(`${path}: 鍵素材に見える値`);
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`, key));
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        walk(val, `${path}.${k}`, k);
      }
    }
  };
  walk(parsed, "$", "");
  return hits;
}

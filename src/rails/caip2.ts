/**
 * network 表記の変換。
 *
 * x402 の 402 応答は `"base-sepolia"` のような slug を使う（x402 v1 spec）。
 * 一方 AgentCore の ProcessPayment payload は CAIP-2（`"eip155:84532"`）を取る、
 * と開発指示書が引く GA quick start に書かれている。
 * SDK の型は payload が __DocumentType（自由形）なので型では確定できない。[要ライブ確認]
 *
 * 変換は testnet のみ。未知の network は投げる（mainnet を素通りさせない）。
 */

const SLUG_TO_CHAIN_ID: Record<string, number> = {
  "base-sepolia": 84532,
  "ethereum-sepolia": 11155111,
  "avalanche-fuji": 43113,
};

const CHAIN_ID_TO_SLUG: Record<number, string> = Object.fromEntries(
  Object.entries(SLUG_TO_CHAIN_ID).map(([slug, id]) => [id, slug]),
);

/** "base-sepolia" → "eip155:84532"。既に CAIP-2 ならそのまま返す。 */
export function toCaip2(network: string): string {
  const n = network.trim().toLowerCase();
  if (/^eip155:\d+$/.test(n)) return n;
  if (/^solana:/.test(n)) return n;
  const id = SLUG_TO_CHAIN_ID[n];
  if (id === undefined) {
    throw new Error(`CAIP-2 へ変換できない network: ${network}（testnet と確認できないため停止）`);
  }
  return `eip155:${id}`;
}

/** "eip155:84532" → "base-sepolia"。未知なら入力をそのまま返す。 */
export function fromCaip2(caip2: string): string {
  const m = /^eip155:(\d+)$/.exec(caip2.trim().toLowerCase());
  if (!m) return caip2;
  return CHAIN_ID_TO_SLUG[Number(m[1])] ?? caip2;
}

export function chainIdOf(network: string): number {
  const m = /^eip155:(\d+)$/.exec(toCaip2(network));
  if (!m) throw new Error(`EVM chainId を取り出せない: ${network}`);
  return Number(m[1]);
}

import {
  MAINNET_CHAINS,
  TESTNET_EVM_CHAIN_IDS,
  TESTNET_X402_NETWORKS,
} from "../config.js";

export class MainnetDetected extends Error {
  constructor(readonly where: string, readonly value: string) {
    super(`mainnet detected (${where}=${value}) — ハーネスを停止する`);
    this.name = "MainnetDetected";
  }
}

const MAINNET_NETWORK_HINTS = [
  "base",
  "ethereum",
  "ethereum-mainnet",
  "base-mainnet",
  "mainnet",
  "solana",
  "polygon",
  "arbitrum",
  "optimism",
];

/**
 * 7節「実マネー禁止フラグ」。
 * 起動時と、402 を受けた直後の 2 箇所で必ず呼ぶ。
 * testnet と確認できないものは全て停止側に倒す（allowlist 方式）。
 */
export function assertTestnetNetwork(network: string): void {
  const n = network.trim().toLowerCase();
  if ((TESTNET_X402_NETWORKS as readonly string[]).includes(n)) return;
  if (n.includes("sepolia") || n.includes("devnet") || n.includes("testnet") || n.includes("fuji")) {
    return;
  }
  if (MAINNET_NETWORK_HINTS.includes(n)) throw new MainnetDetected("network", network);
  throw new MainnetDetected("network(unknown, deny by default)", network);
}

export function assertTestnetChainId(chainId: number): void {
  if (!(TESTNET_EVM_CHAIN_IDS as readonly number[]).includes(chainId)) {
    throw new MainnetDetected("chainId", String(chainId));
  }
}

export function assertTestnetChainEnum(chain: string): void {
  if ((MAINNET_CHAINS as readonly string[]).includes(chain.toUpperCase())) {
    throw new MainnetDetected("BlockchainChainId", chain);
  }
}

/** 起動時ガード。mainnet 鍵・mainnet 設定が混ざっていたら即停止する。 */
export function assertNoMainnetConfig(env: NodeJS.ProcessEnv = process.env): void {
  const suspicious: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(env)) {
    if (!v) continue;
    if (/MAINNET/i.test(k)) suspicious.push([k, "env 名に MAINNET"]);
    if (/^(AGENTCORE_CHAIN|X402_NETWORK)$/i.test(k) && MAINNET_NETWORK_HINTS.includes(v.toLowerCase())) {
      suspicious.push([k, v]);
    }
  }
  if (suspicious.length > 0) {
    throw new MainnetDetected("env", suspicious.map(([k, v]) => `${k}(${v})`).join(","));
  }
}

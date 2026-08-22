/**
 * T1 で確定した AgentCore payments の設定値をここに固定する。
 *
 * 出典（一次情報）:
 *  - AWS SDK for JavaScript v3 の生成モデル
 *    node_modules/@aws-sdk/client-bedrock-agentcore/dist-types/models/enums.d.ts
 *    node_modules/@aws-sdk/client-bedrock-agentcore/dist-types/models/models_[01].d.ts
 *    （docs.aws.amazon.com は本セッションの egress ポリシーで到達不可のため、
 *      同じ API モデルから生成された SDK 型定義を一次情報として使用した。
 *      詳細と引用は docs/T1-agentcore-findings.md）
 */

/** BlockchainChainId enum のうち testnet に相当するもの。 */
export const TESTNET_CHAINS = ["BASE_SEPOLIA", "SOLANA_DEVNET"] as const;

/** BlockchainChainId enum のうち mainnet に相当するもの。触れたら即停止する。 */
export const MAINNET_CHAINS = ["BASE", "ETHEREUM", "SOLANA"] as const;

/** x402 の network 文字列（402 応答内）のうち testnet として許可するもの。 */
export const TESTNET_X402_NETWORKS = [
  "base-sepolia",
  "solana-devnet",
  "avalanche-fuji",
  "sei-testnet",
] as const;

/** MPP methodDetails.chainId のうち testnet として許可するもの（EIP-155）。 */
export const TESTNET_EVM_CHAIN_IDS = [
  84532, // Base Sepolia
  11155111, // Ethereum Sepolia
  43113, // Avalanche Fuji
] as const;

export type TestnetChain = (typeof TESTNET_CHAINS)[number];

export interface HarnessConfig {
  /** AgentCore payments を呼ぶリージョン。 */
  readonly region: string;
  /** 支払いに使うチェーン。testnet のみ許可。 */
  readonly chain: TestnetChain;
  /**
   * facilitator。AgentCore payments は ProcessPayment の内側で
   * ウォレット署名まで行い、決済証明 (PROOF_GENERATED) を返す。
   * 検証・オンチェーン決済を行う facilitator は売り手側が呼ぶため、
   * 買い手ハーネスからは「誰が持っているか」だけを記録する。
   */
  readonly facilitator: string;
  /** 常に true。false にする経路をコード上に持たない。 */
  readonly testnet: true;
  /** ProcessPayment 用の paymentManagerArn（未設定なら AgentCore backend は使えない）。 */
  readonly paymentManagerArn: string | undefined;
  readonly paymentInstrumentId: string | undefined;
  readonly paymentConnectorId: string | undefined;
  /** 上限（層2）。USD 建てを atomic（USDC = 6 decimals）で保持する。 */
  readonly perCallMaxAtomic: bigint;
  readonly sessionMaxAtomic: bigint;
  /** 層3。testnet でも既定オフ。 */
  readonly autoApprove: boolean;
  /** AgentCore の PaymentSession 有効期限（分）。API 制約は 15〜480。 */
  readonly sessionExpiryMinutes: number;
}

/** USD 文字列 → atomic（6 decimals）。"0.05" → 50000n */
export function usdToAtomic(usd: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(usd.trim());
  if (!m) throw new Error(`invalid USD amount: ${usd}`);
  const whole = m[1] ?? "0";
  const frac = (m[2] ?? "").padEnd(6, "0");
  return BigInt(whole) * 1_000_000n + BigInt(frac || "0");
}

/** atomic（6 decimals）→ USD 表示。50000n → "0.050000" */
export function atomicToUsd(atomic: bigint): string {
  const neg = atomic < 0n;
  const a = neg ? -atomic : atomic;
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export function loadConfig(): HarnessConfig {
  const chain = envOr("AGENTCORE_CHAIN", "BASE_SEPOLIA");
  if (!(TESTNET_CHAINS as readonly string[]).includes(chain)) {
    throw new Error(
      `AGENTCORE_CHAIN=${chain} は testnet ではない。許可: ${TESTNET_CHAINS.join(", ")}`,
    );
  }
  return {
    region: envOr("AWS_REGION", "us-east-1"),
    chain: chain as TestnetChain,
    facilitator: envOr("X402_FACILITATOR", "https://x402.org/facilitator"),
    testnet: true,
    paymentManagerArn: process.env["AGENTCORE_PAYMENT_MANAGER_ARN"],
    paymentInstrumentId: process.env["AGENTCORE_PAYMENT_INSTRUMENT_ID"],
    paymentConnectorId: process.env["AGENTCORE_PAYMENT_CONNECTOR_ID"],
    perCallMaxAtomic: usdToAtomic(envOr("PER_CALL_MAX_USD", "0.05")),
    sessionMaxAtomic: usdToAtomic(envOr("SESSION_MAX_USD", "0.20")),
    autoApprove: envOr("AUTO_APPROVE", "false") === "true",
    sessionExpiryMinutes: Number(envOr("SESSION_EXPIRY_MINUTES", "15")),
  };
}

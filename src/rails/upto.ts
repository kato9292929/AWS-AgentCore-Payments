/**
 * x402 upto（EVM）の署名データ。
 *
 * 出典: x402-foundation/x402 specs/schemes/upto/scheme_upto_evm.md と
 *       typescript/packages/mechanisms/evm/src/upto/client/permit2.ts（参照クライアント）
 *
 *  - Permit2 専用（EIP-3009 は使わない）。買い手は事前に USDC を Permit2 へ approve しておく必要がある。
 *    AgentCore では ProcessPayment の cryptoX402.permit2AllowanceLimit を渡すと、
 *    サービスが署名の前にオンチェーンで approve を出す（ガス代はウォレットのネイティブトークン）。
 *  - 署名するのは上限額（permitted.amount = accepts[].amount）。実額は売り手が handler 実行後に決め、
 *    facilitator の /settle に渡す。実額は settlement 応答の `amount` に載る。
 *  - witness.facilitator に extra.facilitatorAddress を入れる。その facilitator 以外は settle できない。
 *
 * ローカル模擬売り手（mock/server.ts）とローカル署名（src/backends/localSigner.ts）が共有する。
 */

export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
/** x402UptoPermit2Proxy（CREATE2 で全チェーン同一アドレス） */
export const UPTO_PROXY_ADDRESS = "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002" as const;
/** x402.org facilitator の /supported が Base Sepolia の upto に載せている facilitatorAddress（2026-10-20 実測） */
export const X402_ORG_FACILITATOR_ADDRESS = "0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf" as const;

export const UPTO_TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Witness: [
    { name: "to", type: "address" },
    { name: "facilitator", type: "address" },
    { name: "validAfter", type: "uint256" },
  ],
} as const;

export interface UptoAuthorization {
  permitted: { token: `0x${string}`; amount: string };
  from: `0x${string}`;
  spender: `0x${string}`;
  nonce: string;
  deadline: string;
  witness: { to: `0x${string}`; facilitator: `0x${string}`; validAfter: string };
}

export function uptoDomain(chainId: number) {
  return { name: "Permit2", chainId, verifyingContract: PERMIT2_ADDRESS } as const;
}

export function uptoMessage(a: UptoAuthorization) {
  return {
    permitted: { token: a.permitted.token, amount: BigInt(a.permitted.amount) },
    spender: a.spender,
    nonce: BigInt(a.nonce),
    deadline: BigInt(a.deadline),
    witness: { to: a.witness.to, facilitator: a.witness.facilitator, validAfter: BigInt(a.witness.validAfter) },
  };
}

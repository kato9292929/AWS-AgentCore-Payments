/**
 * Permit2 への USDC 承認（allowance）をオンチェーンで確かめるための補助（AC-3a / AC-3b）。
 *
 * AgentCore の ProcessPayment は承認 tx のハッシュを返さないので、USDC の Approval イベント
 * （owner = ウォレット、spender = Permit2）をログから引いて、tx ハッシュと gas 代を取る。
 * 承認額そのものは USDC.allowance(wallet, Permit2) を直接読む。
 *
 * 完全に 0 に戻すには、ウォレット側で USDC.approve(Permit2, 0) を送る必要がある。
 * AgentCore の API（permit2AllowanceLimit は正の整数のみ）からはできない。
 */
import { BedrockAgentCoreClient, ProcessPaymentCommand } from "@aws-sdk/client-bedrock-agentcore";
import { randomUUID } from "node:crypto";
import { formatEther, parseAbiItem, type PublicClient } from "viem";
import type { PayToAllowlist } from "../../src/guard/payToAllowlist.js";
import { PERMIT2_ADDRESS } from "../../src/rails/upto.js";

const ALLOWANCE_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const LOG_RANGE = 200n;

const APPROVAL_EVENT = parseAbiItem("event Approval(address indexed owner, address indexed spender, uint256 value)");

export async function permit2Allowance(client: PublicClient, usdc: `0x${string}`, owner: `0x${string}`): Promise<string> {
  const v = await client.readContract({ address: usdc, abi: ALLOWANCE_ABI, functionName: "allowance", args: [owner, PERMIT2_ADDRESS] });
  return v.toString();
}

export interface ApprovalTx {
  txHash: string;
  blockNumber: string;
  value: string;
  gasUsed: string;
  gasCostEth: string;
}

/** fromBlock 以降の Approval(owner→Permit2) を全部返す（gas 代つき）。 */
export async function permit2Approvals(
  client: PublicClient,
  usdc: `0x${string}`,
  owner: `0x${string}`,
  fromBlock: bigint,
): Promise<ApprovalTx[]> {
  // 公開 RPC（sepolia.base.org / mainnet.base.org）は eth_getLogs を 200 ブロックの範囲に制限するので刻んで引く
  const latest = await client.getBlockNumber();
  const logs = [];
  for (let from = fromBlock; from <= latest; from += LOG_RANGE) {
    const to = from + LOG_RANGE - 1n < latest ? from + LOG_RANGE - 1n : latest;
    logs.push(
      ...(await client.getLogs({ address: usdc, event: APPROVAL_EVENT, args: { owner, spender: PERMIT2_ADDRESS }, fromBlock: from, toBlock: to })),
    );
  }
  const out: ApprovalTx[] = [];
  for (const l of logs) {
    const rc = await client.getTransactionReceipt({ hash: l.transactionHash! });
    out.push({
      txHash: l.transactionHash!,
      blockNumber: String(l.blockNumber),
      value: String(l.args.value),
      gasUsed: String(rc.gasUsed),
      gasCostEth: formatEther(rc.gasUsed * rc.effectiveGasPrice),
    });
  }
  return out;
}

/** 期待する値の Approval が現れるまで待つ（承認 tx の確定待ち）。 */
export async function waitForApproval(
  client: PublicClient,
  usdc: `0x${string}`,
  owner: `0x${string}`,
  fromBlock: bigint,
  value: string,
  timeoutMs = 90_000,
): Promise<ApprovalTx | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = (await permit2Approvals(client, usdc, owner, fromBlock)).find((a) => a.value === value);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

export interface ShrinkDeps {
  plane: Pick<BedrockAgentCoreClient, "send">;
  chain: PublicClient;
  managerArn: string;
  instrumentId: string;
  userId: string;
  wallet: `0x${string}` | undefined;
  usdc: `0x${string}`;
  /** 試験と同じ支払い先 allowlist。取り直した 402 の payTo × network がここに無ければ縮めない */
  payTo: PayToAllowlist;
  fresh402: () => Promise<{ accepts: Array<Record<string, unknown>> }>;
  openSession: (maxUsd: string) => Promise<string>;
  budgetOf: (sid: string) => Promise<string | null>;
  closeSession: (sid: string) => Promise<unknown>;
}

/**
 * 試験の最後に Permit2 の承認を 1（0.000001 USDC）に縮める。
 *
 * AgentCore には承認だけを出す API が無く、permit2AllowanceLimit は正の整数しか受けない（0 にはできない）。
 * そこで、同じ売り手から取り直した 402 の upto accept を金額 1 に書き換え、permit2AllowanceLimit="1" で
 * ProcessPayment を 1 回呼ぶ。サービスは署名の前に approve(Permit2, 1) を出す（approve は「設定」なので 1 になる）。
 *
 * このとき生成される支払い署名（paymentOutput）は使わない。どこにも送らず、変数にも残さずに捨てる。
 * 記録するのは processPaymentId・status・承認 tx・gas・予算の変化・縮めた後の allowance だけ。
 * 予算は試験のセッションと分けるため、上限 $0.01 の専用セッションを開いて閉じる。
 */
export async function shrinkAllowance(d: ShrinkDeps): Promise<Record<string, unknown>> {
  const required = await d.fresh402();
  const upto = required.accepts.find((a) => a["scheme"] === "upto");
  if (!upto) return { executed: false, reason: "取り直した 402 に upto が無い" };
  const verdict = d.payTo.check({ payTo: String(upto["payTo"]), network: String(upto["network"]) });
  if (!verdict.allowed) return { executed: false, reason: `payTo allowlist: ${verdict.reason}（ProcessPayment を呼んでいない）` };
  const accept = { ...upto, amount: "1" }; // 署名する金額も最小にする（この署名は使わない）
  const fromBlock = await d.chain.getBlockNumber();
  const sid = await d.openSession("0.01");
  const out: Record<string, unknown> = {
    executed: true,
    permit2AllowanceLimit: "1",
    signed_amount_atomic: "1",
    session: "専用（上限 $0.01）",
    allowance_before: d.wallet ? await permit2Allowance(d.chain, d.usdc, d.wallet) : null,
    budget_before: await d.budgetOf(sid),
  };
  try {
    const res = await d.plane.send(
      new ProcessPaymentCommand({
        paymentManagerArn: d.managerArn,
        paymentSessionId: sid,
        paymentInstrumentId: d.instrumentId,
        userId: d.userId,
        agentName: "ac3-shrink",
        paymentType: "CRYPTO_X402",
        paymentInput: { cryptoX402: { version: "2", payload: accept as never, permit2AllowanceLimit: "1" } },
        clientToken: randomUUID(),
      }),
    );
    // paymentOutput（支払い署名）はここで捨てる。res 自体も記録しない。
    out["processPaymentId"] = res.processPaymentId;
    out["status"] = res.status;
  } catch (e) {
    const err = e as { name?: string; message?: string };
    out["error"] = { name: err.name, message: err.message };
  }
  out["budget_after"] = await d.budgetOf(sid).catch(() => null);
  await d.closeSession(sid);
  if (d.wallet && !out["error"]) {
    out["approve_tx"] = await waitForApproval(d.chain, d.usdc, d.wallet, fromBlock, "1");
    out["approve_gas_eth"] = (out["approve_tx"] as ApprovalTx | null)?.gasCostEth ?? null;
  }
  out["allowance_after"] = d.wallet ? await permit2Allowance(d.chain, d.usdc, d.wallet) : null;
  out["allowance_is_1"] = out["allowance_after"] === "1";
  return out;
}

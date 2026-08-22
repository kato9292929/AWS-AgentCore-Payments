import { randomUUID } from "node:crypto";
import { encodePacked, keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem/accounts";
import type { HarnessConfig } from "../config.js";
import { assertTestnetChainId, assertTestnetNetwork } from "../guard/network.js";
import type { Recorder } from "../log/recorder.js";
import type { PaymentDemand } from "../types.js";
import type { PaymentBackend, Proof } from "./types.js";

/**
 * AgentCore を呼べない環境（AWS 資格情報なし / egress 制限）で、
 * 402 → 署名 → 再送 の HTTP サイクルとガードレールを実行するための代替バックエンド。
 *
 * 位置づけ:
 *  - プロトコル上は本物。EIP-712 / EIP-3009 の署名を実際に作り、
 *    売り手側（mock/server.ts）が viem で署名検証する。
 *  - ただし「AgentCore が署名した」証明ではないし、オンチェーン決済もしない。
 *    採取ログには proofSource: "local-signer" が必ず入る。
 *
 * 鍵の扱い（層1）:
 *  - プロセス起動ごとにメモリ上で新規生成する。ファイルにも env にも書かない。
 *  - closeSession() で参照を落とす。セッションをまたいで保持しない。
 *  - 秘密鍵は private フィールドから外に出す経路を持たない（アドレスのみ公開）。
 */
export class LocalSignerBackend implements PaymentBackend {
  readonly kind = "local-signer" as const;
  #account: PrivateKeyAccount | undefined;
  private sessionId: string | undefined;

  constructor(
    private readonly cfg: HarnessConfig,
    private readonly rec: Recorder,
  ) {}

  get address(): `0x${string}` {
    if (!this.#account) throw new Error("openSession を先に呼ぶこと");
    return this.#account.address;
  }

  async openSession(maxSpendUsd: string, expiryMinutes: number): Promise<string> {
    // 生成した秘密鍵は #account の内側にだけ置き、変数にも残さない。
    this.#account = privateKeyToAccount(generatePrivateKey());
    this.sessionId = `local-${randomUUID()}`;
    this.rec.event("localsigner.session.created", {
      paymentSessionId: this.sessionId,
      walletAddress: this.#account.address, // 公開アドレスは秘密ではない
      maxSpendUsd,
      expiryMinutes,
      note: "ephemeral in-memory testnet key; never persisted",
    });
    return this.sessionId;
  }

  async processPayment(demand: PaymentDemand): Promise<Proof> {
    const account = this.#account;
    if (!account || !this.sessionId) throw new Error("openSession を先に呼ぶこと");

    if (demand.raw.kind === "x402") {
      assertTestnetNetwork(demand.network);
      const req = demand.raw.requirements as {
        asset: string;
        payTo: string;
        maxAmountRequired: string;
        maxTimeoutSeconds?: number;
        extra?: { name?: string; version?: string };
      };
      const chainId = x402NetworkToChainId(demand.network);
      assertTestnetChainId(chainId);

      const now = Math.floor(Date.now() / 1000);
      const authorization = {
        from: account.address,
        to: req.payTo as `0x${string}`,
        value: BigInt(req.maxAmountRequired),
        validAfter: BigInt(now - 60),
        validBefore: BigInt(now + (req.maxTimeoutSeconds ?? 60)),
        nonce: toHex(randomBytes32()) as `0x${string}`,
      };

      const signature = await account.signTypedData({
        domain: {
          name: req.extra?.name ?? "USDC",
          version: req.extra?.version ?? "2",
          chainId,
          verifyingContract: req.asset as `0x${string}`,
        },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: authorization,
      });

      this.rec.event("localsigner.proof.generated", {
        rail: "x402",
        scheme: "exact",
        network: demand.network,
        chainId,
        // 署名そのものはログに残さない（長さだけ）
        signatureLength: signature.length,
      });

      return {
        rail: "x402",
        version: String(demand.raw.x402Version),
        payload: {
          signature,
          authorization: {
            from: authorization.from,
            to: authorization.to,
            value: authorization.value.toString(),
            validAfter: authorization.validAfter.toString(),
            validBefore: authorization.validBefore.toString(),
            nonce: authorization.nonce,
          },
        },
        processPaymentId: `local-${randomUUID()}`,
        status: "PROOF_GENERATED",
      };
    }

    // MPP: evm/charge の type="authorization"（EIP-3009）で署名する。
    const challenge = demand.raw.challenge;
    const request = demand.raw.request as {
      amount: string;
      currency: string;
      recipient: string;
      methodDetails?: { chainId?: number };
    };
    const chainId = request.methodDetails?.chainId;
    if (chainId === undefined) throw new Error("mpp: chainId 不明");
    assertTestnetChainId(chainId);

    const id = challenge["id"];
    const realm = challenge["realm"];
    if (!id || !realm) throw new Error("mpp: challenge の id / realm が無い");

    // 仕様: nonce = keccak256(abi.encodePacked(challenge.id, challenge.realm))
    const nonce = keccak256(encodePacked(["string", "string"], [id, realm]));
    const validBefore = challenge["expires"]
      ? BigInt(Math.floor(new Date(challenge["expires"]).getTime() / 1000))
      : BigInt(Math.floor(Date.now() / 1000) + 300);

    const message = {
      from: account.address,
      to: request.recipient as `0x${string}`,
      value: BigInt(request.amount),
      validAfter: 0n,
      validBefore,
      nonce,
    };

    const signature = await account.signTypedData({
      domain: { name: "USDC", version: "2", chainId, verifyingContract: request.currency as `0x${string}` },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message,
    });

    const credential = {
      challenge: {
        id,
        realm,
        method: challenge["method"],
        intent: challenge["intent"] ?? "charge",
        request: challenge["request"],
        ...(challenge["expires"] ? { expires: challenge["expires"] } : {}),
        ...(challenge["opaque"] ? { opaque: challenge["opaque"] } : {}),
        ...(challenge["digest"] ? { digest: challenge["digest"] } : {}),
      },
      payload: {
        type: "authorization",
        from: message.from,
        to: message.to,
        value: message.value.toString(),
        validAfter: "0",
        validBefore: message.validBefore.toString(),
        nonce,
        signature,
      },
      source: `did:pkh:eip155:${chainId}:${account.address}`,
    };

    this.rec.event("localsigner.proof.generated", {
      rail: "mpp",
      method: challenge["method"],
      intent: challenge["intent"],
      chainId,
      challengeId: id,
      signatureLength: signature.length,
    });

    return {
      rail: "mpp",
      version: "1",
      selectedPaymentId: id,
      paymentCredential: `Payment ${Buffer.from(JSON.stringify(credential), "utf8").toString("base64url")}`,
      processPaymentId: `local-${randomUUID()}`,
      status: "PROOF_GENERATED",
    };
  }

  async closeSession(): Promise<void> {
    // 鍵をセッションをまたいで持たない（3節）。
    this.#account = undefined;
    this.rec.event("localsigner.session.closed", { paymentSessionId: this.sessionId });
    this.sessionId = undefined;
  }
}

function randomBytes32(): Uint8Array {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/** x402 の network 文字列 → EIP-155 chainId。testnet のみ。 */
export function x402NetworkToChainId(network: string): number {
  const map: Record<string, number> = {
    "base-sepolia": 84532,
    "ethereum-sepolia": 11155111,
    "avalanche-fuji": 43113,
  };
  const id = map[network.toLowerCase()];
  if (id === undefined) throw new Error(`未知の network: ${network}（testnet と確認できないため停止）`);
  return id;
}

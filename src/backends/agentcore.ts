import {
  BedrockAgentCoreClient,
  CreatePaymentSessionCommand,
  DeletePaymentSessionCommand,
  ProcessPaymentCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { randomUUID } from "node:crypto";
import type { HarnessConfig } from "../config.js";
import type { Recorder } from "../log/recorder.js";
import type { PaymentDemand } from "../types.js";
import type { PaymentBackend, Proof } from "./types.js";

/**
 * 本番経路。AWS Bedrock AgentCore payments の ProcessPayment を呼ぶ。
 *
 * API 形状の出典は @aws-sdk/client-bedrock-agentcore の生成モデル:
 *  - CreatePaymentSessionRequest{ paymentManagerArn, limits:{maxSpendAmount:{value,currency}},
 *      expiryTimeInMinutes(15-480), userId?, agentName?, clientToken? }
 *  - ProcessPaymentRequest{ paymentManagerArn, paymentSessionId, paymentInstrumentId,
 *      paymentType: "CRYPTO_X402"|"MPP", paymentInput: {cryptoX402:{version,payload}} | {mpp:{version,wwwAuthenticateHeaders,buyerPaysGasFees?}} }
 *  - ProcessPaymentResponse{ status: "PROOF_GENERATED", paymentOutput: {cryptoX402:{version,payload}} | {mpp:{version,selectedPaymentId,paymentCredential}} }
 *
 * 注意: PaymentStatus enum は PROOF_GENERATED のみ。AgentCore は「証明」までを返し、
 * オンチェーン決済は売り手側 facilitator が行う。買い手ハーネスは証明を再送に載せる。
 */
export class AgentCoreBackend implements PaymentBackend {
  readonly kind = "agentcore" as const;
  private readonly client: BedrockAgentCoreClient;
  private sessionId: string | undefined;

  constructor(
    private readonly cfg: HarnessConfig,
    private readonly rec: Recorder,
    private readonly agentName: string,
    private readonly userId: string,
  ) {
    if (!cfg.paymentManagerArn || !cfg.paymentInstrumentId) {
      throw new Error(
        "AGENTCORE_PAYMENT_MANAGER_ARN と AGENTCORE_PAYMENT_INSTRUMENT_ID が必要（T1 のセットアップ）",
      );
    }
    this.client = new BedrockAgentCoreClient({ region: cfg.region });
  }

  async openSession(maxSpendUsd: string, expiryMinutes: number): Promise<string> {
    const res = await this.client.send(
      new CreatePaymentSessionCommand({
        paymentManagerArn: this.cfg.paymentManagerArn!,
        userId: this.userId,
        agentName: this.agentName,
        // 層2 の上限を AgentCore 側にも渡す。ハーネス側の上限と二重にかける。
        limits: { maxSpendAmount: { value: maxSpendUsd, currency: "USD" } },
        expiryTimeInMinutes: expiryMinutes,
        clientToken: randomUUID(),
      }),
    );
    const id = res.paymentSession?.paymentSessionId;
    if (!id) throw new Error("CreatePaymentSession が paymentSessionId を返さなかった");
    this.sessionId = id;
    this.rec.event("agentcore.session.created", {
      paymentSessionId: id,
      maxSpendUsd,
      expiryMinutes,
      region: this.cfg.region,
    });
    return id;
  }

  async processPayment(demand: PaymentDemand): Promise<Proof> {
    if (!this.sessionId) throw new Error("openSession を先に呼ぶこと");

    const input =
      demand.raw.kind === "x402"
        ? {
            cryptoX402: {
              version: String(demand.raw.x402Version),
              payload: demand.raw.requirements as never,
            },
          }
        : {
            mpp: {
              version: "1",
              // 402 の WWW-Authenticate 値を verbatim で渡す（SDK ドキュメント記載どおり）
              wwwAuthenticateHeaders: [demand.raw.wwwAuthenticate],
              // ガス肩代わりは既定で拒否。チャレンジが sponsor しない場合は
              // AgentCore 側が ValidationException を返す（意図した停止）。
              buyerPaysGasFees: false,
            },
          };

    this.rec.event("agentcore.process_payment.request", {
      paymentType: demand.rail === "x402" ? "CRYPTO_X402" : "MPP",
      paymentSessionId: this.sessionId,
      amountAtomic: demand.amountAtomic.toString(),
      network: demand.network,
    });

    const res = await this.client.send(
      new ProcessPaymentCommand({
        paymentManagerArn: this.cfg.paymentManagerArn!,
        paymentSessionId: this.sessionId,
        paymentInstrumentId: this.cfg.paymentInstrumentId!,
        userId: this.userId,
        agentName: this.agentName,
        paymentType: demand.rail === "x402" ? "CRYPTO_X402" : "MPP",
        paymentInput: input,
        clientToken: randomUUID(),
      }),
    );

    this.rec.event("agentcore.process_payment.response", {
      processPaymentId: res.processPaymentId,
      status: res.status,
      paymentType: res.paymentType,
    });

    if (demand.rail === "x402") {
      const out = res.paymentOutput?.cryptoX402;
      if (!out) throw new Error("ProcessPayment が cryptoX402 の出力を返さなかった");
      return {
        rail: "x402",
        version: out.version ?? "1",
        payload: out.payload,
        processPaymentId: res.processPaymentId ?? "",
        status: res.status ?? "",
      };
    }
    const out = res.paymentOutput?.mpp;
    if (!out) throw new Error("ProcessPayment が mpp の出力を返さなかった");
    return {
      rail: "mpp",
      version: out.version ?? "1",
      selectedPaymentId: out.selectedPaymentId ?? "",
      paymentCredential: out.paymentCredential ?? "",
      processPaymentId: res.processPaymentId ?? "",
      status: res.status ?? "",
    };
  }

  async closeSession(): Promise<void> {
    if (!this.sessionId) return;
    // 鍵はセッションをまたいで保持しない（3節「セッション境界」）。
    await this.client.send(
      new DeletePaymentSessionCommand({
        paymentManagerArn: this.cfg.paymentManagerArn!,
        paymentSessionId: this.sessionId,
        userId: this.userId,
      }),
    );
    this.rec.event("agentcore.session.deleted", { paymentSessionId: this.sessionId });
    this.sessionId = undefined;
  }
}

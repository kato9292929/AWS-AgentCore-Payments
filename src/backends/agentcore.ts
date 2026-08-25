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
import { toCaip2 } from "../rails/caip2.js";
import { classifyPaymentStatus, mayRetryWithProof } from "./paymentStatus.js";
import type { PaymentBackend, Proof } from "./types.js";

/**
 * 本番経路。AWS Bedrock AgentCore payments の ProcessPayment を呼ぶ。
 *
 * API 形状の出典は @aws-sdk/client-bedrock-agentcore の生成モデル:
 *  - CreatePaymentSessionRequest{ paymentManagerArn, limits:{maxSpendAmount:{value,currency}},
 *      expiryTimeInMinutes(15-480), userId?, agentName?, clientToken? }
 *  - ProcessPaymentRequest{ paymentManagerArn, paymentSessionId, paymentInstrumentId,
 *      paymentType: "CRYPTO_X402"|"MPP", paymentInput: {cryptoX402:{version,payload}} | {mpp:{version,wwwAuthenticateHeaders,buyerPaysGasFees?}} }
 *  - ProcessPaymentResponse{ status, paymentOutput: {cryptoX402:{version,payload}} | {mpp:{version,selectedPaymentId,paymentCredential}} }
 *
 * status の扱いは src/backends/paymentStatus.ts を読むこと。
 * SDK 3.1117.0 の PaymentStatus enum は PROOF_GENERATED のみだが、
 * GA の quick start は PENDING/SUCCESS/FAILED としている。両者が食い違っているので
 * status は不透明な文字列として扱い、分類だけを classifyPaymentStatus() に寄せてある。
 * [要ライブ確認] 実際に返る値と、SUCCESS 時点でオンチェーン確定しているか。
 *
 * 買い手再送モデル（402 の再送は買い手が行う）は変えていない。x402 の仕様がそうだから。
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

  async processPayment(demand: PaymentDemand, opts: { clientToken: string }): Promise<Proof> {
    if (!this.sessionId) throw new Error("openSession を先に呼ぶこと");

    const input =
      demand.raw.kind === "x402"
        ? {
            cryptoX402: {
              version: String(demand.raw.x402Version),
              payload: buildX402Payload(demand) as never,
            },
          }
        : {
            mpp: {
              // SDK 3.1117.0 の PaymentType enum は CRYPTO_X402 と MPP の 2 値。
              // GA quick start に明記があるのは CRYPTO_X402 のみなので、
              // MPP 側の enum 値は [要ライブ確認]。型が通る限りは "MPP" を使う。
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
        // demand ごとに固定。同じ請求で 2 回叩いても AgentCore 側で冪等になる。
        clientToken: opts.clientToken,
      }),
    );

    const outcome = classifyPaymentStatus(res.status);
    this.rec.event("agentcore.process_payment.response", {
      processPaymentId: res.processPaymentId,
      // status は verbatim で残す。分類はこちらの解釈でしかない。
      status: res.status,
      outcome,
      paymentType: res.paymentType,
      ...(outcome === "unknown"
        ? { note: "未知の status。決済に進まない（[要ライブ確認]）" }
        : {}),
    });

    if (!mayRetryWithProof(outcome)) {
      throw new Error(`ProcessPayment の status が ${res.status ?? "(なし)"}（outcome=${outcome}）のため中止`);
    }

    if (demand.rail === "x402") {
      const out = res.paymentOutput?.cryptoX402;
      if (!out) throw new Error("ProcessPayment が cryptoX402 の出力を返さなかった");
      return {
        rail: "x402",
        version: out.version ?? "1",
        payload: out.payload,
        processPaymentId: res.processPaymentId ?? "",
        status: res.status ?? "",
        outcome,
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
      outcome,
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

/**
 * x402 の ProcessPayment payload を組み立てる。
 *
 * 二つの形が候補にある。[要ライブ確認]
 *  - "quickstart": GA quick start が示す形。network は CAIP-2（eip155:84532）。
 *  - "requirements": 402 の accepts[] のエントリを verbatim で渡す（network は slug）。
 *
 * 既定は quickstart。AGENTCORE_X402_PAYLOAD_MODE=requirements で切り替えられる。
 * ライブ 1 回目で ValidationException が出たらもう一方に倒す。
 */
export function buildX402Payload(demand: PaymentDemand): Record<string, unknown> {
  if (demand.raw.kind !== "x402") throw new Error("x402 の demand ではない");
  const req = demand.raw.requirements as Record<string, unknown>;
  const mode = process.env["AGENTCORE_X402_PAYLOAD_MODE"] ?? "quickstart";
  if (mode === "requirements") return req;

  return {
    scheme: demand.scheme,
    network: toCaip2(demand.network),
    // 最小単位の文字列。402 の maxAmountRequired をそのまま使う。
    amount: demand.amountAtomic.toString(),
    asset: demand.asset,
    payTo: demand.payTo,
    ...(req["maxTimeoutSeconds"] !== undefined ? { maxTimeoutSeconds: req["maxTimeoutSeconds"] } : {}),
    ...(req["extra"] !== undefined ? { extra: req["extra"] } : {}),
    ...(req["resource"] !== undefined ? { resource: req["resource"] } : {}),
  };
}

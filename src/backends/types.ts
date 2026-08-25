import type { PaymentOutcome } from "./paymentStatus.js";
import type { PaymentDemand } from "../types.js";

export type Proof =
  | {
      rail: "x402";
      /** ProcessPayment のレスポンス paymentOutput.cryptoX402.version */
      version: string;
      /** X-PAYMENT ヘッダに載せる payload。 */
      payload: unknown;
      processPaymentId: string;
      /** サービスが返した status を verbatim で保持する。 */
      status: string;
      /** status をこちらで分類した結果。判断はこちらを使う。 */
      outcome: PaymentOutcome;
    }
  | {
      rail: "mpp";
      version: string;
      selectedPaymentId: string;
      /** そのまま Authorization ヘッダに載せる "Payment <base64url>"。 */
      paymentCredential: string;
      processPaymentId: string;
      status: string;
      outcome: PaymentOutcome;
    };

/**
 * 決済証明を作る層。モデルからは見えない。
 * 鍵・ウォレット・署名はこの内側にしか存在しない（層1）。
 */
export interface PaymentBackend {
  readonly kind: "agentcore" | "local-signer";
  /** セッション上限つきの決済セッションを開く。戻り値はセッション ID。 */
  openSession(maxSpendUsd: string, expiryMinutes: number): Promise<string>;
  /**
   * 402 の支払い要求に対する証明を生成する。決済の再送は呼び出し側が行う。
   * clientToken は demand ごとに固定された冪等トークン（二重署名の抑止）。
   */
  processPayment(demand: PaymentDemand, opts: { clientToken: string }): Promise<Proof>;
  closeSession(): Promise<void>;
}

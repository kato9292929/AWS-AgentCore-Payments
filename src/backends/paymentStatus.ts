/**
 * ProcessPayment の応答 status の扱い。
 *
 * ここが厄介なので経緯を残す（[要ライブ確認]）。
 *
 * 2026-08-25 時点で、二つの一次情報が食い違っている。
 *
 *  (a) AWS SDK の生成モデル @aws-sdk/client-bedrock-agentcore@3.1117.0
 *      models/enums.d.ts:
 *          export declare const PaymentStatus = { readonly PROOF_GENERATED: "PROOF_GENERATED" };
 *      → GA 後に発行された SDK でも値は PROOF_GENERATED の 1 つだけ。
 *
 *  (b) 開発指示書が引く AWS「AgentCore payments quick start」(payments-getting-started.html):
 *      → 応答 status は PENDING / SUCCESS / FAILED。
 *
 * 本セッションから docs.aws.amazon.com は egress 許可外（403）で読めないため、
 * どちらが現行かを確定できない。**推測でどちらかに寄せない。**
 *
 * 方針: status は不透明な文字列として verbatim にログへ残し、
 * 「決済を続けてよいか」の判定だけをこの関数で行う。
 * 両方の enum を受けられるので、どちらが正でも動く。
 *
 * ライブ 1 回目で確定させること:
 *   - 実際に返る値は何か
 *   - SUCCESS が返る時点でオンチェーン確定しているか（＝買い手再送が要るのか）
 */

export type PaymentOutcome = "proof_only" | "settled" | "pending" | "failed" | "unknown";

/**
 * proof_only … 証明までは出た。買い手が 402 へ再送する必要がある（x402 準拠の従来モデル）
 * settled   … サービス側で完了扱い。再送が要るかは [要ライブ確認]
 * pending   … 処理中。証明が使えるかは不明なので、再送はするが receipt に不確定を残す
 * failed    … 決済に進まない
 * unknown   … 未知の値。停止側に倒す（決済に進まない）
 */
export function classifyPaymentStatus(status: string | undefined): PaymentOutcome {
  switch ((status ?? "").toUpperCase()) {
    case "PROOF_GENERATED":
      return "proof_only";
    case "SUCCESS":
    case "SUCCEEDED":
    case "COMPLETED":
    case "SETTLED":
      return "settled";
    case "PENDING":
    case "IN_PROGRESS":
    case "PROCESSING":
      return "pending";
    case "FAILED":
    case "DECLINED":
    case "ERROR":
      return "failed";
    default:
      return "unknown";
  }
}

/** 証明をヘッダに載せて 402 へ再送してよいか。 */
export function mayRetryWithProof(outcome: PaymentOutcome): boolean {
  return outcome === "proof_only" || outcome === "settled" || outcome === "pending";
}

/**
 * receipt に載せる「オンチェーン確定を名乗ってよいか」。
 * proof_only / pending は名乗らない。settled は [要ライブ確認] が済むまで名乗らない。
 */
export function settlementConfirmedByService(outcome: PaymentOutcome): boolean {
  // ライブ確認が済むまでは、いかなる outcome でも「確定」を名乗らせない。
  // 確定の根拠は売り手が返す receipt（X-PAYMENT-RESPONSE / Payment-Receipt）に置く。
  void outcome;
  return false;
}

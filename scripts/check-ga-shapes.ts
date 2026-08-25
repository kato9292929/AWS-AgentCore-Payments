/**
 * 方向A の受け入れ確認。資格情報なしで走る。
 *
 * SDK の enum を実際に読んで、コードが前提にしている値が今も存在するかを見る。
 * SDK 側が変わったらここが落ちるので、GA 差分に気づける。
 */
import { PaymentType, PaymentStatus } from "@aws-sdk/client-bedrock-agentcore";
import {
  PaymentConnectorType,
  PaymentCredentialProviderVendorType,
  PaymentManagerStatus,
  PaymentsAuthorizerType,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { buildX402Payload } from "../src/backends/agentcore.js";
import { classifyPaymentStatus, mayRetryWithProof } from "../src/backends/paymentStatus.js";
import { chainIdOf, fromCaip2, toCaip2 } from "../src/rails/caip2.js";
import type { PaymentDemand } from "../src/types.js";

const problems: string[] = [];
const eq = (got: unknown, want: unknown, label: string): void => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    problems.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
  }
};

// --- SDK enum の実測（docs が読めないので、ここが一次情報） ---
const sdkEnums = {
  PaymentType: Object.values(PaymentType).sort(),
  PaymentStatus: Object.values(PaymentStatus).sort(),
  PaymentConnectorType: Object.values(PaymentConnectorType).sort(),
  PaymentCredentialProviderVendorType: Object.values(PaymentCredentialProviderVendorType).sort(),
  PaymentManagerStatus: Object.values(PaymentManagerStatus).sort(),
  PaymentsAuthorizerType: Object.values(PaymentsAuthorizerType).sort(),
};

// コードが前提にしている値が消えていないか
if (!sdkEnums.PaymentType.includes("MPP")) problems.push("PaymentType から MPP が消えた");
if (!sdkEnums.PaymentType.includes("CRYPTO_X402")) problems.push("PaymentType から CRYPTO_X402 が消えた");
if (!sdkEnums.PaymentsAuthorizerType.includes("AWS_IAM")) problems.push("PaymentsAuthorizerType から AWS_IAM が消えた");

// --- status 分類（両方の enum 系列を受けられること） ---
eq(classifyPaymentStatus("PROOF_GENERATED"), "proof_only", "classify PROOF_GENERATED");
eq(classifyPaymentStatus("SUCCESS"), "settled", "classify SUCCESS");
eq(classifyPaymentStatus("PENDING"), "pending", "classify PENDING");
eq(classifyPaymentStatus("FAILED"), "failed", "classify FAILED");
eq(classifyPaymentStatus("SOMETHING_NEW"), "unknown", "classify 未知値");
eq(mayRetryWithProof("failed"), false, "failed で再送しない");
eq(mayRetryWithProof("unknown"), false, "unknown で再送しない");
eq(mayRetryWithProof("proof_only"), true, "proof_only で再送する");

// --- CAIP-2 ---
eq(toCaip2("base-sepolia"), "eip155:84532", "toCaip2 base-sepolia");
eq(toCaip2("eip155:84532"), "eip155:84532", "toCaip2 冪等");
eq(fromCaip2("eip155:84532"), "base-sepolia", "fromCaip2");
eq(chainIdOf("base-sepolia"), 84532, "chainIdOf");
for (const bad of ["base", "ethereum", "polygon"]) {
  try {
    toCaip2(bad);
    problems.push(`toCaip2("${bad}") が通ってしまった（mainnet を素通りさせている）`);
  } catch {
    /* 期待どおり */
  }
}

// --- ProcessPayment payload の 2 モード ---
const demand: PaymentDemand = {
  rail: "x402",
  scheme: "exact",
  network: "base-sepolia",
  amountAtomic: 10000n,
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  raw: {
    kind: "x402",
    x402Version: 1,
    requirements: {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "10000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    },
    body: {},
  },
};

delete process.env["AGENTCORE_X402_PAYLOAD_MODE"];
const quickstart = buildX402Payload(demand);
eq(quickstart["network"], "eip155:84532", "quickstart payload は CAIP-2");
eq(quickstart["amount"], "10000", "quickstart payload の amount は最小単位の文字列");
eq(quickstart["scheme"], "exact", "quickstart payload の scheme");

process.env["AGENTCORE_X402_PAYLOAD_MODE"] = "requirements";
const verbatim = buildX402Payload(demand);
eq(verbatim["network"], "base-sepolia", "requirements payload は 402 の slug のまま");
delete process.env["AGENTCORE_X402_PAYLOAD_MODE"];

if (problems.length > 0) {
  console.error("NG:\n" + problems.map((p) => ` - ${p}`).join("\n"));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      check: "ga-shapes",
      result: "ok",
      sdk: {
        "@aws-sdk/client-bedrock-agentcore": (
          await import("@aws-sdk/client-bedrock-agentcore/package.json", { with: { type: "json" } })
        ).default.version,
      },
      sdk_enums_observed: sdkEnums,
      unresolved: [
        "ProcessPayment の status 実値（SDK は PROOF_GENERATED のみ / GA docs は PENDING|SUCCESS|FAILED）",
        "MPP の paymentType enum 値（SDK は MPP、GA quick start は CRYPTO_X402 のみ記載）",
        "ProcessPayment payload の network 表記（CAIP-2 か slug か）",
      ],
    },
    null,
    2,
  ),
);

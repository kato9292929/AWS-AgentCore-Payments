/**
 * T1: この環境から AgentCore payments のどこまで届くかを一次確認する。
 * 資格情報の実体には触れない。API がどの例外を返すかだけを記録する。
 */
import { BedrockAgentCoreClient, ListPaymentSessionsCommand } from "@aws-sdk/client-bedrock-agentcore";
import { BedrockAgentCoreControlClient, ListPaymentManagersCommand } from "@aws-sdk/client-bedrock-agentcore-control";
import { writeFileSync } from "node:fs";

const region = process.env["AWS_REGION"] ?? "us-east-1";
const bogusArn = "arn:aws:bedrock-agentcore:us-east-1:000000000000:payment-manager/probe";
const out: Record<string, unknown> = { region, probedAt: new Date().toISOString() };

async function probe(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const r = await fn();
    out[name] = { ok: true, response: JSON.parse(JSON.stringify(r)) };
  } catch (e) {
    const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
    out[name] = {
      ok: false,
      errorName: err.name,
      httpStatus: err.$metadata?.httpStatusCode,
      message: err.message,
    };
  }
}

const data = new BedrockAgentCoreClient({ region, maxAttempts: 1 });
const control = new BedrockAgentCoreControlClient({ region, maxAttempts: 1 });

await probe("dataPlane_ListPaymentSessions", () =>
  data.send(new ListPaymentSessionsCommand({ paymentManagerArn: bogusArn, maxResults: 1 })),
);
await probe("controlPlane_ListPaymentManagers", () =>
  control.send(new ListPaymentManagersCommand({ maxResults: 1 })),
);

writeFileSync("artifacts/aws-access-probe.json", `${JSON.stringify(out, null, 2)}\n`, "utf8");
console.log(JSON.stringify(out, null, 2));

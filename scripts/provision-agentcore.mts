/**
 * AgentCore payments のプロビジョニング（GA の 6 段）。
 *
 *   1. CreatePaymentCredentialProvider  … Coinbase CDP / Stripe Privy の資格情報を預ける
 *   2. CreatePaymentManager             … トップリソース。READY になるまで待つ
 *   3. CreatePaymentConnector           … manager と provider をつなぐ。READY になるまで待つ
 *   4. CreatePaymentInstrument          … 買い手ウォレット。redirectUrl を人間が開いて入金
 *   5. （待機）                          … instrument が ACTIVE になるまで
 *   6. GetPaymentInstrumentBalance      … 原資が入ったかの確認（任意）
 *
 * 出力は artifacts/provision-output.json と標準出力。
 * **クレデンシャルは出力にもログにも出さない。** 出るのは ARN / ID / status だけ。
 *
 * 使い方:
 *   export AWS_REGION=us-west-2
 *   export AGENTCORE_ROLE_ARN=arn:aws:iam::<acct>:role/<role>
 *   export PAYMENT_USER_EMAIL=you@example.com
 *   # Coinbase CDP を使う場合
 *   export CDP_API_KEY_ID=... CDP_API_KEY_SECRET=... CDP_WALLET_SECRET=...
 *   # Stripe Privy を使う場合
 *   export PRIVY_APP_ID=... PRIVY_APP_SECRET=... PRIVY_AUTHORIZATION_ID=... PRIVY_AUTHORIZATION_PRIVATE_KEY=...
 *
 *   npx tsx scripts/provision-agentcore.mts
 *   npx tsx scripts/provision-agentcore.mts --dry-run   # 資格情報なしで手順と入力だけ確認
 */
import {
  BedrockAgentCoreClient,
  CreatePaymentInstrumentCommand,
  GetPaymentInstrumentBalanceCommand,
  GetPaymentInstrumentCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  BedrockAgentCoreControlClient,
  CreatePaymentConnectorCommand,
  CreatePaymentCredentialProviderCommand,
  CreatePaymentManagerCommand,
  GetPaymentConnectorCommand,
  GetPaymentManagerCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertNoMainnetConfig } from "../src/guard/network.js";

const DRY_RUN = process.argv.includes("--dry-run");
const REGION = process.env["AWS_REGION"] ?? "us-east-1";
const NAME_PREFIX = process.env["PROVISION_NAME_PREFIX"] ?? "buyer-harness";
const OUT_PATH = resolve("artifacts", "provision-output.json");

type Vendor = "CoinbaseCDP" | "StripePrivy";

interface Step {
  step: string;
  status: "ok" | "skipped" | "failed" | "planned";
  detail: Record<string, unknown>;
}

const steps: Step[] = [];
const note = (step: string, status: Step["status"], detail: Record<string, unknown>): void => {
  steps.push({ step, status, detail });
  process.stdout.write(`[${status.toUpperCase().padEnd(7)}] ${step} ${JSON.stringify(detail)}\n`);
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} が必要`);
  return v;
}

/** どちらのベンダを使うかを env から決める。両方揃っていたら CDP を優先。 */
function pickVendor(): Vendor {
  if (process.env["CDP_API_KEY_ID"]) return "CoinbaseCDP";
  if (process.env["PRIVY_APP_ID"]) return "StripePrivy";
  throw new Error(
    "CDP_API_KEY_ID か PRIVY_APP_ID のどちらかが必要（1-B / 1-C）",
  );
}

/**
 * providerConfigurationInput を組み立てる。
 * 値は返り値の中にしか置かず、ログにも出力ファイルにも入れない。
 */
function buildProviderConfiguration(vendor: Vendor) {
  if (vendor === "CoinbaseCDP") {
    return {
      coinbaseCdpConfiguration: {
        apiKeyId: requireEnv("CDP_API_KEY_ID"),
        apiKeySecret: requireEnv("CDP_API_KEY_SECRET"),
        walletSecret: requireEnv("CDP_WALLET_SECRET"),
      },
    };
  }
  return {
    stripePrivyConfiguration: {
      appId: requireEnv("PRIVY_APP_ID"),
      appSecret: requireEnv("PRIVY_APP_SECRET"),
      authorizationId: requireEnv("PRIVY_AUTHORIZATION_ID"),
      authorizationPrivateKey: requireEnv("PRIVY_AUTHORIZATION_PRIVATE_KEY"),
    },
  };
}

async function poll<T>(
  label: string,
  fn: () => Promise<T>,
  isDone: (v: T) => boolean,
  isFailed: (v: T) => boolean,
  describe: (v: T) => string,
  { intervalMs = 5000, timeoutMs = 600_000 } = {},
): Promise<T> {
  const started = Date.now();
  let last = "";
  for (;;) {
    const v = await fn();
    const d = describe(v);
    if (d !== last) {
      process.stdout.write(`  ${label}: ${d}\n`);
      last = d;
    }
    if (isFailed(v)) throw new Error(`${label} が失敗状態になった: ${d}`);
    if (isDone(v)) return v;
    if (Date.now() - started > timeoutMs) throw new Error(`${label} がタイムアウト（最終状態: ${d}）`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function main(): Promise<number> {
  // testnet 以外の設定が混ざっていないか（7節の実マネー禁止ガード）
  assertNoMainnetConfig();
  mkdirSync(resolve("artifacts"), { recursive: true });

  const vendor = DRY_RUN ? ((process.env["PROVISION_VENDOR"] as Vendor) ?? "CoinbaseCDP") : pickVendor();
  const userEmail = DRY_RUN
    ? (process.env["PAYMENT_USER_EMAIL"] ?? "<PAYMENT_USER_EMAIL>")
    : requireEnv("PAYMENT_USER_EMAIL");
  const roleArn = DRY_RUN
    ? (process.env["AGENTCORE_ROLE_ARN"] ?? "<AGENTCORE_ROLE_ARN>")
    : requireEnv("AGENTCORE_ROLE_ARN");
  const suffix = randomUUID().slice(0, 8);

  const plan = {
    region: REGION,
    vendor,
    roleArn,
    userEmail,
    names: {
      credentialProvider: `${NAME_PREFIX}-cred-${suffix}`,
      paymentManager: `${NAME_PREFIX}-manager-${suffix}`,
      paymentConnector: `${NAME_PREFIX}-connector-${suffix}`,
    },
    // testnet 固定。ウォレットの network は CryptoWalletNetwork enum（ETHEREUM|SOLANA）で、
    // 実際にどのチェーンで払うかは 402 の要求と ProcessPayment の payload が決める。
    walletNetwork: "ETHEREUM" as const,
  };

  if (DRY_RUN) {
    note("dry-run", "planned", plan);
    for (const s of [
      "1. CreatePaymentCredentialProvider",
      "2. CreatePaymentManager → GetPaymentManager が READY になるまで待つ",
      "3. CreatePaymentConnector → READY（PENDING_AUTHENTICATION なら authorizationUrl を人間が開く）",
      "4. CreatePaymentInstrument → redirectUrl を人間が開いて入金",
      "5. GetPaymentInstrument が ACTIVE になるまで待つ",
      "6. GetPaymentInstrumentBalance で原資を確認",
    ]) {
      note(s, "planned", {});
    }
    writeOutput({ dryRun: true, plan, steps, result: null });
    return 0;
  }

  const control = new BedrockAgentCoreControlClient({ region: REGION });
  const data = new BedrockAgentCoreClient({ region: REGION });

  // ---- 1. credential provider ----
  const cred = await control.send(
    new CreatePaymentCredentialProviderCommand({
      name: plan.names.credentialProvider,
      credentialProviderVendor: vendor,
      providerConfigurationInput: buildProviderConfiguration(vendor),
    }),
  );
  const credentialProviderArn = cred.credentialProviderArn;
  if (!credentialProviderArn) throw new Error("credentialProviderArn が返らなかった");
  note("1. CreatePaymentCredentialProvider", "ok", { credentialProviderArn, vendor });

  // ---- 2. payment manager ----
  const mgr = await control.send(
    new CreatePaymentManagerCommand({
      name: plan.names.paymentManager,
      description: "buyer harness (testnet)",
      authorizerType: "AWS_IAM",
      roleArn,
      clientToken: randomUUID(),
    }),
  );
  const paymentManagerArn = mgr.paymentManagerArn;
  const paymentManagerId = mgr.paymentManagerId;
  if (!paymentManagerArn || !paymentManagerId) throw new Error("paymentManagerArn / Id が返らなかった");
  note("2. CreatePaymentManager", "ok", { paymentManagerArn, paymentManagerId });

  await poll(
    "PaymentManager",
    () => control.send(new GetPaymentManagerCommand({ paymentManagerId })),
    (v) => v.status === "READY",
    (v) => v.status === "CREATE_FAILED",
    (v) => String(v.status),
  );
  note("2b. GetPaymentManager READY", "ok", { paymentManagerId });

  // ---- 3. connector ----
  const connector = await control.send(
    new CreatePaymentConnectorCommand({
      paymentManagerId,
      name: plan.names.paymentConnector,
      type: vendor,
      credentialProviderConfigurations: [
        vendor === "CoinbaseCDP"
          ? { coinbaseCDP: { credentialProviderArn } }
          : { stripePrivy: { credentialProviderArn } },
      ],
      provisionMode: "MANUAL",
      clientToken: randomUUID(),
    }),
  );
  const paymentConnectorId = connector.paymentConnectorId;
  if (!paymentConnectorId) throw new Error("paymentConnectorId が返らなかった");
  note("3. CreatePaymentConnector", "ok", {
    paymentConnectorId,
    status: connector.status,
    ...(connector.authorizationUrl ? { authorizationUrl: connector.authorizationUrl } : {}),
  });

  if (connector.authorizationUrl) {
    process.stdout.write(
      `\n  >>> OAuth 同意が必要。ブラウザで開く: ${connector.authorizationUrl}\n\n`,
    );
  }

  await poll(
    "PaymentConnector",
    () => control.send(new GetPaymentConnectorCommand({ paymentManagerId, paymentConnectorId })),
    (v) => v.status === "READY",
    (v) =>
      v.status === "CREATE_FAILED" ||
      v.status === "AUTHENTICATION_FAILED" ||
      v.status === "AUTHENTICATION_EXPIRED",
    (v) => `${v.status}${v.authorizationUrl ? ` (open: ${v.authorizationUrl})` : ""}`,
  );
  note("3b. GetPaymentConnector READY", "ok", { paymentConnectorId });

  // ---- 4. instrument ----
  const inst = await data.send(
    new CreatePaymentInstrumentCommand({
      userId: userEmail,
      agentName: "buyer-harness",
      paymentManagerArn,
      paymentConnectorId,
      paymentInstrumentType: "EMBEDDED_CRYPTO_WALLET",
      paymentInstrumentDetails: {
        embeddedCryptoWallet: {
          network: plan.walletNetwork,
          linkedAccounts: [{ email: { emailAddress: userEmail } }],
        },
      },
      clientToken: randomUUID(),
    }),
  );
  const instrument = inst.paymentInstrument;
  const paymentInstrumentId = instrument?.paymentInstrumentId;
  if (!paymentInstrumentId) throw new Error("paymentInstrumentId が返らなかった");
  const redirectUrl = instrument?.paymentInstrumentDetails?.embeddedCryptoWallet?.redirectUrl;
  note("4. CreatePaymentInstrument", "ok", {
    paymentInstrumentId,
    status: instrument?.status,
    walletAddress: instrument?.paymentInstrumentDetails?.embeddedCryptoWallet?.walletAddress,
    ...(redirectUrl ? { redirectUrl } : {}),
  });

  if (redirectUrl) {
    process.stdout.write(
      [
        "",
        "  >>> 人手が要る。ブラウザで次を開き、ウォレットの紐付けと testnet USDC の入金を済ませる:",
        `      ${redirectUrl}`,
        "      Base Sepolia の USDC: 0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        "",
      ].join("\n"),
    );
  }

  // ---- 5. ACTIVE 待ち ----
  await poll(
    "PaymentInstrument",
    () =>
      data.send(
        new GetPaymentInstrumentCommand({
          userId: userEmail,
          paymentManagerArn,
          paymentConnectorId,
          paymentInstrumentId,
        }),
      ),
    (v) => v.paymentInstrument?.status === "ACTIVE",
    (v) => v.paymentInstrument?.status === "FAILED" || v.paymentInstrument?.status === "BLOCKED",
    (v) => String(v.paymentInstrument?.status),
    { intervalMs: 10_000, timeoutMs: 1_800_000 },
  );
  note("5. PaymentInstrument ACTIVE", "ok", { paymentInstrumentId });

  // ---- 6. 残高確認（任意。失敗しても続行） ----
  try {
    const bal = await data.send(
      new GetPaymentInstrumentBalanceCommand({
        userId: userEmail,
        paymentManagerArn,
        paymentConnectorId,
        paymentInstrumentId,
        chain: "BASE_SEPOLIA",
        token: "USDC",
      }),
    );
    note("6. GetPaymentInstrumentBalance", "ok", {
      chain: "BASE_SEPOLIA",
      token: "USDC",
      tokenBalance: bal.tokenBalance as unknown as Record<string, unknown>,
    });
  } catch (e) {
    note("6. GetPaymentInstrumentBalance", "skipped", { error: (e as Error).message });
  }

  const result = {
    region: REGION,
    vendor,
    credentialProviderArn,
    paymentManagerArn,
    paymentManagerId,
    paymentConnectorId,
    paymentInstrumentId,
  };
  writeOutput({ dryRun: false, plan, steps, result });

  process.stdout.write(
    [
      "",
      "──────── 次はこれを env に入れてライブ一周 ────────",
      `export AWS_REGION=${REGION}`,
      `export AGENTCORE_PAYMENT_MANAGER_ARN=${paymentManagerArn}`,
      `export AGENTCORE_PAYMENT_INSTRUMENT_ID=${paymentInstrumentId}`,
      `export AGENTCORE_PAYMENT_CONNECTOR_ID=${paymentConnectorId}`,
      "npm run harness -- --label=x402-live --backend=agentcore --allow-live \\",
      "  --endpoint=<公開売り手の URL> --rail=x402 --approve=prompt",
      "",
    ].join("\n"),
  );
  return 0;
}

function writeOutput(payload: Record<string, unknown>): void {
  writeFileSync(OUT_PATH, `${JSON.stringify({ generatedAt: new Date().toISOString(), ...payload }, null, 2)}\n`, "utf8");
  process.stdout.write(`\n出力: ${OUT_PATH}\n`);
}

main()
  .then((code) => process.exit(code))
  .catch((err: Error) => {
    note("provision", "failed", { error: err.message });
    writeOutput({ dryRun: DRY_RUN, steps, result: null, error: err.message });
    process.stderr.write(`\nプロビジョニング失敗: ${err.message}\n`);
    process.exit(1);
  });

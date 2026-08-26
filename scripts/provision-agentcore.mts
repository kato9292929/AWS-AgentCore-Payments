/**
 * AgentCore payments のプロビジョニング。
 *
 * 2 つのモードがある。既定は quick-create。
 *
 *   quick-create（Coinbase CDP のみ）:
 *     1. CreatePaymentManager        … READY を待つ
 *     2. CreatePaymentConnector      … provisionMode=QUICK_CREATE。
 *                                      PENDING_AUTHENTICATION で authorizationUrl が返るので
 *                                      人間がブラウザで OAuth 同意 → READY を待つ
 *     3. CreatePaymentInstrument     … redirectUrl を人間が開いて署名許可＋入金
 *     4. （待機）                     … instrument が ACTIVE になるまで
 *     5. GetPaymentInstrumentBalance … 原資の確認（任意）
 *
 *     CDP の apiKeyId / apiKeySecret / walletSecret は**要らない**。
 *     credential provider はサービス側が同意後に作る。
 *
 *   manual（Stripe Privy、または CDP の鍵を手で持ち込む場合）:
 *     0. CreatePaymentCredentialProvider … 資格情報を預ける
 *     以降は quick-create と同じ 1〜5。
 *
 * 出力は artifacts/provision-output.json と標準出力。
 * **クレデンシャルは出力にもログにも出さない。** 出るのは ARN / ID / status / URL だけ。
 *
 * 使い方:
 *   export AWS_REGION=us-west-2
 *   export AGENTCORE_ROLE_ARN=arn:aws:iam::<acct>:role/<role>
 *   export PAYMENT_USER_EMAIL=you@example.com
 *
 *   npx tsx scripts/provision-agentcore.mts                     # quick-create（既定）
 *   npx tsx scripts/provision-agentcore.mts --dry-run           # 手順と入力だけ確認
 *   npx tsx scripts/provision-agentcore.mts --mode=manual       # 鍵を手で持ち込む
 *
 *   manual のとき追加で必要な env:
 *     CDP:   CDP_API_KEY_ID / CDP_API_KEY_SECRET / CDP_WALLET_SECRET
 *     Privy: PRIVY_APP_ID / PRIVY_APP_SECRET / PRIVY_AUTHORIZATION_ID / PRIVY_AUTHORIZATION_PRIVATE_KEY
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
const MODE: "quick-create" | "manual" =
  process.argv.find((a) => a.startsWith("--mode="))?.slice(7) === "manual" ? "manual" : "quick-create";
const REGION = process.env["AWS_REGION"] ?? "us-east-1";
const NAME_PREFIX = process.env["PROVISION_NAME_PREFIX"] ?? "buyer-harness";
const OUT_PATH = resolve("artifacts", "provision-output.json");

type Vendor = "CoinbaseCDP" | "StripePrivy";

interface Step {
  step: string;
  status: "ok" | "skipped" | "failed" | "planned" | "waiting";
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

function banner(lines: string[]): void {
  process.stdout.write(`\n${"─".repeat(72)}\n${lines.join("\n")}\n${"─".repeat(72)}\n\n`);
}

/** manual モードでどちらのベンダを使うかを env から決める。両方揃っていたら CDP を優先。 */
function pickManualVendor(): Vendor {
  if (process.env["CDP_API_KEY_ID"]) return "CoinbaseCDP";
  if (process.env["PRIVY_APP_ID"]) return "StripePrivy";
  throw new Error("manual モードには CDP_API_KEY_ID か PRIVY_APP_ID のどちらかが必要");
}

/**
 * providerConfigurationInput を組み立てる（manual モードのみ）。
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
  // testnet 以外の設定が混ざっていないか（実マネー禁止ガード）
  assertNoMainnetConfig();
  mkdirSync(resolve("artifacts"), { recursive: true });

  // quick-create は Coinbase CDP のみ。Privy は Quick Create 非対応。
  const vendor: Vendor =
    MODE === "quick-create" ? "CoinbaseCDP" : DRY_RUN ? "CoinbaseCDP" : pickManualVendor();

  const userEmail = DRY_RUN
    ? (process.env["PAYMENT_USER_EMAIL"] ?? "<PAYMENT_USER_EMAIL>")
    : requireEnv("PAYMENT_USER_EMAIL");
  const roleArn = DRY_RUN
    ? (process.env["AGENTCORE_ROLE_ARN"] ?? "<AGENTCORE_ROLE_ARN>")
    : requireEnv("AGENTCORE_ROLE_ARN");
  const suffix = randomUUID().slice(0, 8);

  const plan = {
    mode: MODE,
    region: REGION,
    vendor,
    roleArn,
    userEmail,
    names: {
      paymentManager: `${NAME_PREFIX}-manager-${suffix}`,
      paymentConnector: `${NAME_PREFIX}-connector-${suffix}`,
      ...(MODE === "manual" ? { credentialProvider: `${NAME_PREFIX}-cred-${suffix}` } : {}),
    },
    // instrument の network は CryptoWalletNetwork enum（ETHEREUM|SOLANA）。
    // 実際にどのチェーンで払うかは 402 の要求と ProcessPayment の payload が決める。
    // ETHEREUM を選ぶので、売り手は EVM 系（base-sepolia 等）を提示するものに揃えること。
    walletNetwork: "ETHEREUM" as const,
    credentialsNeeded:
      MODE === "quick-create"
        ? "なし（OAuth 同意でサービスが credential provider を作る）"
        : vendor === "CoinbaseCDP"
          ? "CDP_API_KEY_ID / CDP_API_KEY_SECRET / CDP_WALLET_SECRET"
          : "PRIVY_APP_ID / PRIVY_APP_SECRET / PRIVY_AUTHORIZATION_ID / PRIVY_AUTHORIZATION_PRIVATE_KEY",
  };

  if (DRY_RUN) {
    note("dry-run", "planned", plan);
    const stepList =
      MODE === "quick-create"
        ? [
            "1. CreatePaymentManager → READY を待つ",
            "2. CreatePaymentConnector（QUICK_CREATE）→ authorizationUrl を人間が開いて OAuth 同意 → READY を待つ",
            "3. CreatePaymentInstrument → redirectUrl を人間が開いて署名許可＋入金",
            "4. GetPaymentInstrument が ACTIVE になるまで待つ",
            "5. GetPaymentInstrumentBalance で原資を確認",
          ]
        : [
            "0. CreatePaymentCredentialProvider（鍵を預ける）",
            "1. CreatePaymentManager → READY を待つ",
            "2. CreatePaymentConnector（MANUAL）→ READY を待つ",
            "3. CreatePaymentInstrument → redirectUrl を人間が開いて署名許可＋入金",
            "4. GetPaymentInstrument が ACTIVE になるまで待つ",
            "5. GetPaymentInstrumentBalance で原資を確認",
          ];
    for (const s of stepList) note(s, "planned", {});
    writeOutput({ dryRun: true, mode: MODE, plan, steps, result: null });
    return 0;
  }

  const control = new BedrockAgentCoreControlClient({ region: REGION });
  const data = new BedrockAgentCoreClient({ region: REGION });

  // ---- 0. credential provider（manual のみ） ----
  let credentialProviderArn: string | undefined;
  if (MODE === "manual") {
    const cred = await control.send(
      new CreatePaymentCredentialProviderCommand({
        name: plan.names.credentialProvider!,
        credentialProviderVendor: vendor,
        providerConfigurationInput: buildProviderConfiguration(vendor),
      }),
    );
    credentialProviderArn = cred.credentialProviderArn;
    if (!credentialProviderArn) throw new Error("credentialProviderArn が返らなかった");
    note("0. CreatePaymentCredentialProvider", "ok", { credentialProviderArn, vendor });
  } else {
    note("0. CreatePaymentCredentialProvider", "skipped", {
      reason: "QUICK_CREATE ではサービス側が OAuth 同意後に作る",
    });
  }

  // ---- 1. payment manager ----
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
  note("1. CreatePaymentManager", "ok", { paymentManagerArn, paymentManagerId });

  await poll(
    "PaymentManager",
    () => control.send(new GetPaymentManagerCommand({ paymentManagerId })),
    (v) => v.status === "READY",
    (v) => v.status === "CREATE_FAILED",
    (v) => String(v.status),
  );
  note("1b. GetPaymentManager READY", "ok", { paymentManagerId });

  // ---- 2. connector ----
  const connector = await control.send(
    new CreatePaymentConnectorCommand({
      paymentManagerId,
      name: plan.names.paymentConnector,
      type: vendor,
      // QUICK_CREATE では空配列。サービスが同意フローを回して provider を用意する。
      credentialProviderConfigurations:
        MODE === "quick-create"
          ? []
          : [
              vendor === "CoinbaseCDP"
                ? { coinbaseCDP: { credentialProviderArn: credentialProviderArn! } }
                : { stripePrivy: { credentialProviderArn: credentialProviderArn! } },
            ],
      provisionMode: MODE === "quick-create" ? "QUICK_CREATE" : "MANUAL",
      clientToken: randomUUID(),
    }),
  );
  const paymentConnectorId = connector.paymentConnectorId;
  if (!paymentConnectorId) throw new Error("paymentConnectorId が返らなかった");
  note("2. CreatePaymentConnector", "ok", {
    paymentConnectorId,
    provisionMode: MODE === "quick-create" ? "QUICK_CREATE" : "MANUAL",
    status: connector.status,
    ...(connector.authorizationUrl ? { authorizationUrl: connector.authorizationUrl } : {}),
  });

  if (connector.authorizationUrl) {
    banner([
      "  人手 (1/2): Coinbase の OAuth 同意",
      "",
      "  ブラウザで開いて同意する:",
      `    ${connector.authorizationUrl}`,
      "",
      "  同意が済むと connector が READY になる。ここで待機する。",
    ]);
    note("2a. OAuth 同意待ち", "waiting", { authorizationUrl: connector.authorizationUrl });
  }

  // 同意は人間の操作なので長めに待つ。
  // authorizationUrl は PENDING_AUTHENTICATION の間だけ返るので、
  // 更新されたら都度出し直す（期限切れで貼り直される場合がある）。
  let shownUrl = connector.authorizationUrl ?? "";
  await poll(
    "PaymentConnector",
    () => control.send(new GetPaymentConnectorCommand({ paymentManagerId, paymentConnectorId })),
    (v) => v.status === "READY",
    (v) =>
      v.status === "CREATE_FAILED" ||
      v.status === "AUTHENTICATION_FAILED" ||
      v.status === "AUTHENTICATION_EXPIRED" ||
      v.status === "AWS_MARKETPLACE_SUBSCRIPTION_REQUIRED",
    (v) => {
      if (v.authorizationUrl && v.authorizationUrl !== shownUrl) {
        shownUrl = v.authorizationUrl;
        process.stdout.write(`\n  同意 URL が更新された: ${v.authorizationUrl}\n\n`);
      }
      return String(v.status);
    },
    { intervalMs: 10_000, timeoutMs: 1_800_000 },
  );
  note("2b. GetPaymentConnector READY", "ok", { paymentConnectorId });

  // ---- 3. instrument ----
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
  const walletAddress = instrument?.paymentInstrumentDetails?.embeddedCryptoWallet?.walletAddress;
  note("3. CreatePaymentInstrument", "ok", {
    paymentInstrumentId,
    status: instrument?.status,
    walletAddress,
    ...(redirectUrl ? { redirectUrl } : {}),
  });

  if (redirectUrl) {
    banner([
      "  人手 (2/2): 署名許可の付与と testnet USDC の入金",
      "",
      "  Coinbase ホストの WalletHub をブラウザで開く:",
      `    ${redirectUrl}`,
      "",
      "  ここで 2 つやる:",
      "    1) このウォレットでの署名をエージェントに許可する",
      "    2) Base Sepolia の testnet USDC を入金する",
      `       トークン: 0x036CbD53842c5426634e7929541eC2318f3dCF7e`,
      walletAddress ? `       ウォレット: ${walletAddress}` : "",
      "",
      "  済むと instrument が ACTIVE になる。ここで待機する。",
    ].filter(Boolean));
    note("3a. 署名許可・入金待ち", "waiting", { redirectUrl, walletAddress });
  }

  // ---- 4. ACTIVE 待ち ----
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
  note("4. PaymentInstrument ACTIVE", "ok", { paymentInstrumentId });

  // ---- 5. 残高確認（任意。失敗しても続行） ----
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
    note("5. GetPaymentInstrumentBalance", "ok", {
      chain: "BASE_SEPOLIA",
      token: "USDC",
      tokenBalance: bal.tokenBalance as unknown as Record<string, unknown>,
    });
  } catch (e) {
    note("5. GetPaymentInstrumentBalance", "skipped", { error: (e as Error).message });
  }

  const result = {
    mode: MODE,
    region: REGION,
    vendor,
    ...(credentialProviderArn ? { credentialProviderArn } : {}),
    paymentManagerArn,
    paymentManagerId,
    paymentConnectorId,
    paymentInstrumentId,
    walletAddress,
  };
  writeOutput({ dryRun: false, mode: MODE, plan, steps, result });

  banner([
    "  次はこれを env に入れてライブ一周",
    "",
    `export AWS_REGION=${REGION}`,
    `export AGENTCORE_PAYMENT_MANAGER_ARN=${paymentManagerArn}`,
    `export AGENTCORE_PAYMENT_INSTRUMENT_ID=${paymentInstrumentId}`,
    `export AGENTCORE_PAYMENT_CONNECTOR_ID=${paymentConnectorId}`,
    "",
    "npm run harness -- --label=x402-live --backend=agentcore --allow-live \\",
    "  --endpoint=<公開売り手の URL> --rail=x402 --approve=prompt",
  ]);
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
    writeOutput({ dryRun: DRY_RUN, mode: MODE, steps, result: null, error: err.message });
    process.stderr.write(`\nプロビジョニング失敗: ${err.message}\n`);
    process.exit(1);
  });

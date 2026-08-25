/**
 * ローカル模擬売り手 + facilitator（testnet 相当・オンチェーン決済なし）
 *
 * なぜ必要か:
 *   本セッションの egress ポリシーは mpp.dev / x402.org / docs.aws.amazon.com を 403 で塞ぐ。
 *   公開テストエンドポイントに到達できないため、402 → 署名 → 再送 → 200 の
 *   HTTP サイクルとガードレールの動作を採取するための代替を用意する。
 *
 * 何が本物で、何が本物でないか:
 *   本物  : HTTP ステータスとヘッダの形（x402 / MPP 仕様どおり）、
 *           EIP-712 / EIP-3009 署名の生成と検証（viem で実際に verify する）、
 *           チャレンジ束縛（MPP は HMAC-SHA256 binding、nonce = keccak256(id,realm)）
 *   本物でない: オンチェーン決済。tx hash は決済シミュレーションの識別子であって
 *           base-sepolia のエクスプローラには存在しない。receipt には
 *           merchant: "mock-local" が必ず入る。
 */
import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { encodePacked, keccak256, verifyTypedData } from "viem";

const PORT = Number(process.env["MOCK_PORT"] ?? 8402);
const HOST = "127.0.0.1";
const REALM = `${HOST}:${PORT}`;
const CHAIN_ID = 84532; // Base Sepolia
const NETWORK = "base-sepolia";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const CHALLENGE_SECRET = randomBytes(32); // プロセス内のみ

/**
 * 使用済み nonce。EIP-3009 はトークンコントラクトが nonce の一意性を強制するので、
 * オンチェーンなら再利用は必ず落ちる。ここでもそれを再現する。
 * （これが無いと「同じ署名を投げ直せば何度でも通る」模擬になってしまう）
 */
const USED_NONCES = new Set<string>();

interface Resource {
  path: string;
  rail: "x402" | "mpp";
  /** atomic（USDC 6 decimals） */
  amount: string;
  description: string;
  content: unknown;
}

const RESOURCES: Resource[] = [
  {
    path: "/x402/weather",
    rail: "x402",
    amount: "10000", // $0.01
    description: "Testnet weather sample (x402 exact)",
    content: { city: "Tokyo", tempC: 27, source: "mock-local" },
  },
  {
    path: "/x402/premium",
    rail: "x402",
    amount: "500000", // $0.50 — per_call_max 超過の採取用
    description: "Testnet premium sample (x402 exact, over-limit fixture)",
    content: { report: "premium", source: "mock-local" },
  },
  {
    path: "/x402/standard",
    rail: "x402",
    amount: "30000", // $0.03 — 承認済み金額($0.01)は超えるが per_call_max($0.05)は超えない
    description: "Testnet standard sample (承認範囲の検証用)",
    content: { report: "standard", source: "mock-local" },
  },
  {
    path: "/x402/always-402",
    rail: "x402",
    amount: "10000",
    description: "正しい支払いでも 402 を返し続ける売り手（再送上限の検証用）",
    content: { note: "never served" },
  },
  {
    path: "/x402/mainnet-trap",
    rail: "x402",
    amount: "10000",
    description: "mainnet を提示してくる売り手（実マネー禁止ガードの採取用）",
    content: { note: "should never be reachable" },
  },
  {
    path: "/mpp/quote",
    rail: "mpp",
    amount: "20000", // $0.02
    description: "Testnet quote sample (MPP evm/charge)",
    content: { symbol: "USDC", quote: "1.0001", source: "mock-local" },
  },
];

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function log(...args: unknown[]): void {
  process.stderr.write(`[mock-merchant] ${args.map(String).join(" ")}\n`);
}

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

function jcs(obj: Record<string, unknown>): string {
  // JSON Canonicalization Scheme の必要部分（キー辞書順・入れ子対応）
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canon(o[k])]));
    }
    return v;
  };
  return JSON.stringify(canon(obj));
}

/** MPP core spec: 推奨の HMAC-SHA256 challenge binding。 */
function bindChallenge(params: Record<string, string>): string {
  const input = ["realm", "method", "intent", "request", "expires", "opaque"]
    .map((k) => `${k}=${params[k] ?? ""}`)
    .join("\n");
  return createHmac("sha256", CHALLENGE_SECRET).update(input).digest("base64url");
}

// ---------------- facilitator（別プロセス相当。HTTP で呼ばれる） ----------------

interface VerifyRequest {
  rail: "x402" | "mpp";
  signature: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
  asset: `0x${string}`;
  chainId: number;
  domainName: string;
  domainVersion: string;
}

async function facilitatorVerify(req: VerifyRequest): Promise<{ valid: boolean; reason?: string }> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (USED_NONCES.has(req.nonce.toLowerCase())) {
    // オンチェーンなら transferWithAuthorization が revert する場面
    return { valid: false, reason: "nonce_already_used" };
  }
  if (BigInt(req.validBefore) < now) return { valid: false, reason: "authorization_expired" };
  if (BigInt(req.validAfter) > now) return { valid: false, reason: "authorization_not_yet_valid" };

  // 壊れた署名は verifyTypedData が例外を投げる（v が不正など）。
  // 売り手が 500 を返すと「サーバの不具合」と区別がつかないので、
  // ここで握って 402 invalid_signature に落とす。
  let ok = false;
  try {
    ok = await verifyTypedData({
      address: req.from,
      domain: {
        name: req.domainName,
        version: req.domainVersion,
        chainId: req.chainId,
        verifyingContract: req.asset,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: req.from,
        to: req.to,
        value: BigInt(req.value),
        validAfter: BigInt(req.validAfter),
        validBefore: BigInt(req.validBefore),
        nonce: req.nonce,
      },
      signature: req.signature,
    });
  } catch (err) {
    log("verify threw:", (err as Error).message);
    return { valid: false, reason: "invalid_signature" };
  }
  return ok ? { valid: true } : { valid: false, reason: "invalid_signature" };
}

/** 決済シミュレーション。オンチェーン送信はしない。nonce はここで消費する。 */
function facilitatorSettle(nonce: string): { success: true; transaction: string } {
  USED_NONCES.add(nonce.toLowerCase());
  // 決済参照は nonce から決定論的に作る（同一 nonce の再送を同じ参照に落とす）
  const tx = keccak256(encodePacked(["string", "bytes32"], ["mock-settlement", nonce as `0x${string}`]));
  return { success: true, transaction: tx };
}

// ---------------- x402 ----------------

function x402Challenge(res: ServerResponse, r: Resource, url: string): void {
  // 実マネー禁止ガードを踏ませるための fixture。ここだけ mainnet を提示する。
  const network = r.path === "/x402/mainnet-trap" ? "base" : NETWORK;
  const body = {
    x402Version: 1,
    error: "X-PAYMENT header is required",
    accepts: [
      {
        scheme: "exact",
        network,
        maxAmountRequired: r.amount,
        asset: USDC,
        payTo: PAY_TO,
        resource: url,
        description: r.description,
        mimeType: "application/json",
        outputSchema: null,
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
  res.writeHead(402, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleX402(req: IncomingMessage, res: ServerResponse, r: Resource, url: string): Promise<void> {
  const header = req.headers["x-payment"];
  if (!header || typeof header !== "string") {
    log("402", r.path);
    x402Challenge(res, r, url);
    return;
  }

  let payment: {
    x402Version: number;
    scheme: string;
    network: string;
    payload: {
      signature: `0x${string}`;
      authorization: {
        from: `0x${string}`;
        to: `0x${string}`;
        value: string;
        validAfter: string;
        validBefore: string;
        nonce: `0x${string}`;
      };
    };
  };
  try {
    payment = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ x402Version: 1, error: "malformed X-PAYMENT" }));
    return;
  }

  const a = payment.payload.authorization;
  if (a.value !== r.amount) {
    log("402 (amount mismatch)", a.value, "!=", r.amount);
    x402Challenge(res, r, url);
    return;
  }
  if (a.to.toLowerCase() !== PAY_TO.toLowerCase()) {
    x402Challenge(res, r, url);
    return;
  }

  const verify = await facilitatorVerify({
    rail: "x402",
    signature: payment.payload.signature,
    from: a.from,
    to: a.to,
    value: a.value,
    validAfter: a.validAfter,
    validBefore: a.validBefore,
    nonce: a.nonce,
    asset: USDC as `0x${string}`,
    chainId: CHAIN_ID,
    domainName: "USDC",
    domainVersion: "2",
  });
  if (!verify.valid) {
    log("402 (verify failed)", verify.reason);
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({ x402Version: 1, error: verify.reason }));
    return;
  }

  if (r.path === "/x402/always-402") {
    // 検証は通ったが受け付けない売り手。買い手が署名し直して投げ直さないことを確かめる。
    log("402 (merchant refuses despite valid payment)", r.path);
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({ x402Version: 1, error: "merchant refuses this payment" }));
    return;
  }

  const settle = facilitatorSettle(a.nonce);
  const settlement = { success: true, transaction: settle.transaction, network: NETWORK, payer: a.from };
  log("200", r.path, "settled(simulated)", settle.transaction.slice(0, 18));
  res.writeHead(200, {
    "content-type": "application/json",
    "x-payment-response": Buffer.from(JSON.stringify(settlement), "utf8").toString("base64"),
  });
  res.end(JSON.stringify({ ...(r.content as object), paid: true, settlement_simulated: true }));
}

// ---------------- MPP ----------------

function mppChallenge(res: ServerResponse, r: Resource): void {
  const request = jcsObject({
    amount: r.amount,
    currency: USDC,
    recipient: PAY_TO,
    description: r.description,
    methodDetails: { chainId: CHAIN_ID, credentialTypes: ["authorization"], decimals: 6 },
  });
  const expires = new Date(Date.now() + 5 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const params: Record<string, string> = {
    realm: REALM,
    method: "evm",
    intent: "charge",
    expires,
    request,
  };
  const id = bindChallenge(params);
  const challenge =
    `Payment id="${id}", realm="${params["realm"]}", method="${params["method"]}", ` +
    `intent="${params["intent"]}", expires="${params["expires"]}", request="${params["request"]}"`;

  res.writeHead(402, {
    "content-type": "application/problem+json",
    "www-authenticate": challenge,
  });
  res.end(
    JSON.stringify({
      type: "https://mpp.dev/problems/payment-required",
      title: "Payment Required",
      status: 402,
      detail: r.description,
    }),
  );
}

function jcsObject(o: Record<string, unknown>): string {
  return Buffer.from(jcs(o), "utf8").toString("base64url");
}

async function handleMpp(req: IncomingMessage, res: ServerResponse, r: Resource): Promise<void> {
  const auth = req.headers["authorization"];
  if (!auth || typeof auth !== "string" || !/^Payment\s/i.test(auth)) {
    log("402", r.path);
    mppChallenge(res, r);
    return;
  }

  let credential: {
    challenge: Record<string, string>;
    payload: {
      type: string;
      from: `0x${string}`;
      to: `0x${string}`;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: `0x${string}`;
      signature: `0x${string}`;
    };
    source?: string;
  };
  try {
    credential = JSON.parse(Buffer.from(auth.replace(/^Payment\s+/i, ""), "base64url").toString("utf8"));
  } catch {
    log("402 (malformed credential)");
    mppChallenge(res, r);
    return;
  }

  // チャレンジ束縛の検証: 返ってきたパラメータから id を再計算して一致を見る
  const c = credential.challenge;
  const recomputed = bindChallenge({
    realm: c["realm"] ?? "",
    method: c["method"] ?? "",
    intent: c["intent"] ?? "",
    request: c["request"] ?? "",
    expires: c["expires"] ?? "",
    opaque: c["opaque"] ?? "",
  });
  if (recomputed !== c["id"]) {
    log("402 (invalid-challenge: binding mismatch)");
    mppChallenge(res, r);
    return;
  }
  if (c["expires"] && new Date(c["expires"]).getTime() < Date.now()) {
    log("402 (challenge expired)");
    mppChallenge(res, r);
    return;
  }

  const request = JSON.parse(Buffer.from(c["request"] ?? "", "base64url").toString("utf8")) as {
    amount: string;
    currency: string;
    recipient: string;
  };
  if (request.amount !== r.amount) {
    mppChallenge(res, r);
    return;
  }

  if (credential.payload.type !== "authorization") {
    log("402 (unsupported credential type)", credential.payload.type);
    mppChallenge(res, r);
    return;
  }

  // 仕様: nonce = keccak256(abi.encodePacked(challenge.id, challenge.realm))
  const expectedNonce = keccak256(encodePacked(["string", "string"], [c["id"] ?? "", c["realm"] ?? ""]));
  if (credential.payload.nonce.toLowerCase() !== expectedNonce.toLowerCase()) {
    log("402 (nonce not bound to challenge)");
    mppChallenge(res, r);
    return;
  }
  if (credential.payload.value !== request.amount) {
    mppChallenge(res, r);
    return;
  }
  if (credential.payload.to.toLowerCase() !== request.recipient.toLowerCase()) {
    mppChallenge(res, r);
    return;
  }

  const verify = await facilitatorVerify({
    rail: "mpp",
    signature: credential.payload.signature,
    from: credential.payload.from,
    to: credential.payload.to,
    value: credential.payload.value,
    validAfter: credential.payload.validAfter,
    validBefore: credential.payload.validBefore,
    nonce: credential.payload.nonce,
    asset: request.currency as `0x${string}`,
    chainId: CHAIN_ID,
    domainName: "USDC",
    domainVersion: "2",
  });
  if (!verify.valid) {
    log("402 (verify failed)", verify.reason);
    mppChallenge(res, r);
    return;
  }

  const settle = facilitatorSettle(credential.payload.nonce);
  const receipt = {
    status: "success",
    method: "evm",
    timestamp: new Date().toISOString(),
    reference: settle.transaction,
  };
  log("200", r.path, "settled(simulated)", settle.transaction.slice(0, 18));
  res.writeHead(200, {
    "content-type": "application/json",
    "payment-receipt": b64urlJson(receipt),
  });
  res.end(JSON.stringify({ ...(r.content as object), paid: true, settlement_simulated: true }));
}

// ---------------- routing ----------------

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  const url = `http://${REALM}${path}`;

  if (path === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, resources: RESOURCES.map((r) => r.path) }));
    return;
  }
  if (path === "/directory") {
    // MPP/x402 ディレクトリ相当。discover が引ける形で返す。
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        endpoints: RESOURCES.map((r) => ({
          id: r.path.replace(/\//g, "-").slice(1),
          rail: r.rail,
          endpoint: `http://${REALM}${r.path}`,
          description: r.description,
          statedPrice: (Number(r.amount) / 1e6).toFixed(6),
          kind: "mock-local",
          reachability: "ok",
        })),
      }),
    );
    return;
  }

  const resource = RESOURCES.find((r) => r.path === path);
  if (!resource) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const handler = resource.rail === "x402" ? handleX402(req, res, resource, url) : handleMpp(req, res, resource);
  handler.catch((err: Error) => {
    log("500", err.message);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  });
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${REALM}  (testnet simulation, no on-chain settlement)`);
});

/**
 * mock/server.ts（模擬売り手 + facilitator）の検証が本当に効いているかを確かめる。
 *
 * これが無いと「模擬売り手が何でも 200 を返しているだけ」かもしれない。
 * 落ちるべきものが落ちることを、実際の HTTP で確認する。
 *
 *   1. 正しい支払い → 200
 *   2. 同じ X-PAYMENT を再送（nonce 再利用）→ 402 nonce_already_used
 *   3. 署名を改竄（別人の署名になる）→ 402 invalid_signature
 *   3a. 形式が壊れた署名 → 500 ではなく 402
 *   4. MPP: チャレンジのパラメータを書き換え → 402（HMAC binding 不一致）
 *   5. MPP: nonce をチャレンジに束縛しない値にする → 402
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSignerBackend } from "../src/backends/localSigner.js";
import { loadConfig } from "../src/config.js";
import { Recorder } from "../src/log/recorder.js";
import * as mpp from "../src/rails/mpp.js";
import * as x402 from "../src/rails/x402.js";
import { b64encode } from "../src/rails/http.js";

const BASE = process.env["MOCK_BASE"] ?? "http://127.0.0.1:8402";
const problems: string[] = [];
const results: Array<Record<string, unknown>> = [];

const rec = new Recorder({ runId: "check-facilitator", dir: mkdtempSync(join(tmpdir(), "facil-")) });
const backend = new LocalSignerBackend(loadConfig(), rec);
await backend.openSession("1.00", 15);

function expectStatus(label: string, got: number, want: number, extra: Record<string, unknown> = {}): void {
  const ok = got === want;
  if (!ok) problems.push(`${label}: status ${got}（期待 ${want}）`);
  results.push({ case: label, status: got, expected: want, ok, ...extra });
}

// --- x402 ---
const endpoint = `${BASE}/x402/weather`;
const bare = await x402.probe(rec, endpoint);
const { demand } = x402.parse402(bare);
const proof = await backend.processPayment(demand, { clientToken: "check-1" });
if (proof.rail !== "x402") throw new Error("x402 の proof ではない");

const header = b64encode({
  x402Version: Number(proof.version),
  scheme: demand.scheme,
  network: demand.network,
  payload: proof.payload,
});

const first = await fetch(endpoint, { headers: { "X-PAYMENT": header } });
expectStatus("1. 正しい支払い", first.status, 200);

const replay = await fetch(endpoint, { headers: { "X-PAYMENT": header } });
const replayBody = (await replay.json()) as { error?: string };
expectStatus("2. 同じ支払いを再送（nonce 再利用）", replay.status, 402, { error: replayBody.error });
if (replay.status === 402 && replayBody.error !== "nonce_already_used") {
  problems.push(`2: 402 だが理由が nonce_already_used でない（${replayBody.error}）`);
}

// 3. 署名の改竄。
// 未使用の nonce で署名し直してから壊す。使用済み nonce を壊しても
// nonce チェックで先に落ちてしまい、署名検証まで到達しないため。
const bare2 = await x402.probe(rec, endpoint);
const parsed2 = x402.parse402(bare2);
const proof2 = await backend.processPayment(parsed2.demand, { clientToken: "check-3" });
if (proof2.rail !== "x402") throw new Error("x402 の proof ではない");

const tampered = structuredClone(proof2.payload) as {
  signature: string;
  authorization: { nonce: string };
};
// r の途中を 1 バイト差し替える。署名としては形式が妥当なまま、
// 復元されるアドレスだけが変わる（＝別人が署名した状態）。
// 末尾を触ると v が壊れて「形式不正」という別の経路になるので、そちらは 3a で見る。
const mid = 20;
const cur = tampered.signature.slice(mid, mid + 2);
tampered.signature = `${tampered.signature.slice(0, mid)}${cur === "ab" ? "cd" : "ab"}${tampered.signature.slice(mid + 2)}`;

const badSig = await fetch(endpoint, {
  headers: {
    "X-PAYMENT": b64encode({
      x402Version: Number(proof2.version),
      scheme: parsed2.demand.scheme,
      network: parsed2.demand.network,
      payload: tampered,
    }),
  },
});
const badSigBody = (await badSig.json()) as { error?: string };
expectStatus("3. 署名の改竄（未使用 nonce で）", badSig.status, 402, { error: badSigBody.error });
if (badSigBody.error === "nonce_already_used") {
  problems.push("3: nonce チェックで落ちており、署名検証に到達していない");
}
if (badSig.status === 402 && badSigBody.error !== "invalid_signature") {
  problems.push(`3: 402 だが理由が invalid_signature でない（${badSigBody.error}）`);
}

// 3a. 形式そのものが壊れた署名でも 500 ではなく 402 で返ること
const malformed = structuredClone(proof2.payload) as { signature: string };
// 末尾の v を不正な値にする（viem が例外を投げる経路）
const malformedRes = await fetch(endpoint, {
  headers: {
    "X-PAYMENT": b64encode({
      x402Version: Number(proof2.version),
      scheme: parsed2.demand.scheme,
      network: parsed2.demand.network,
      payload: { ...malformed, signature: `${malformed.signature.slice(0, -2)}07` },
    }),
  },
});
const malformedBody = (await malformedRes.json()) as { error?: string };
expectStatus("3a. 形式が壊れた署名（500 を返さないこと）", malformedRes.status, 402, {
  error: malformedBody.error,
});

// 3c. 壊していない同じ署名は通ること（3 が「何でも 402」でないことの確認）
const goodAgain = await fetch(endpoint, {
  headers: {
    "X-PAYMENT": b64encode({
      x402Version: Number(proof2.version),
      scheme: parsed2.demand.scheme,
      network: parsed2.demand.network,
      payload: proof2.payload,
    }),
  },
});
expectStatus("3c. 同じ nonce の正しい署名", goodAgain.status, 200);

// --- MPP ---
const mppEndpoint = `${BASE}/mpp/quote`;
const mppBare = await mpp.probe(rec, mppEndpoint);
const parsedMpp = mpp.parse402(mppBare);
const mppProof = await backend.processPayment(parsedMpp.demand, { clientToken: "check-2" });
if (mppProof.rail !== "mpp") throw new Error("mpp の proof ではない");

const credentialJson = JSON.parse(
  Buffer.from(mppProof.paymentCredential.replace(/^Payment\s+/i, ""), "base64url").toString("utf8"),
) as { challenge: Record<string, string>; payload: Record<string, string> };

// 4. request（金額が入っている）を書き換える → HMAC binding が合わなくなる
const tamperedChallenge = structuredClone(credentialJson);
const req = JSON.parse(
  Buffer.from(tamperedChallenge.challenge["request"] ?? "", "base64url").toString("utf8"),
) as Record<string, unknown>;
req["amount"] = "1";
tamperedChallenge.challenge["request"] = Buffer.from(JSON.stringify(req), "utf8").toString("base64url");
const tamperedRes = await fetch(mppEndpoint, {
  headers: {
    Authorization: `Payment ${Buffer.from(JSON.stringify(tamperedChallenge), "utf8").toString("base64url")}`,
  },
});
expectStatus("4. MPP チャレンジの書き換え", tamperedRes.status, 402);

// 5. nonce をチャレンジに束縛しない値にする
const badNonce = structuredClone(credentialJson);
badNonce.payload["nonce"] = `0x${"11".repeat(32)}`;
const badNonceRes = await fetch(mppEndpoint, {
  headers: {
    Authorization: `Payment ${Buffer.from(JSON.stringify(badNonce), "utf8").toString("base64url")}`,
  },
});
expectStatus("5. MPP nonce をチャレンジに束縛しない", badNonceRes.status, 402);

// 6. 正しい MPP 支払いは通る（上の 402 が「常に 402」ではないことの確認）
const mppOk = await fetch(mppEndpoint, { headers: { Authorization: mppProof.paymentCredential } });
expectStatus("6. 正しい MPP 支払い", mppOk.status, 200);

await backend.closeSession();

if (problems.length > 0) {
  console.error("NG:\n" + problems.map((p) => ` - ${p}`).join("\n"));
  console.error(JSON.stringify(results, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ check: "facilitator", result: "ok", cases: results }, null, 2));

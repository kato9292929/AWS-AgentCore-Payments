/**
 * 層1（鍵保管）の能動テスト。
 *
 * これまでの check:secrets は「採取済みログに鍵素材が無い」ことしか見ていない。
 * 鍵が一度も流れていないだけかもしれないので、**わざと流して落ちるか**を確かめる。
 */
import { findKeyMaterial, maskHeaderValue, redact, REDACTED } from "../src/guard/redact.js";

const problems: string[] = [];

// 実在しない値。形だけ本物に似せてある。
const FAKE = {
  privateKey: "0x4c0883a69102937d6231471b5dbb6204fe512961708279e2c1b1c1b1c1b1c1b1",
  walletSecret: "SGVsbG9UaGlzSXNBRmFrZVdhbGxldFNlY3JldFZhbHVlMTIzNDU2Nzg5MA==",
  apiKeySecret: "cdp_fake_secret_value_do_not_use_0123456789",
  authorizationPrivateKey: "-----BEGIN EC PRIVATE KEY-----\nZmFrZQ==\n-----END EC PRIVATE KEY-----",
  mnemonic: "test test test test test test test test test test test junk",
};

function assertGone(label: string, value: unknown, needles: string[]): void {
  const text = JSON.stringify(redact(value));
  for (const n of needles) {
    if (text.includes(n)) problems.push(`${label}: 「${n.slice(0, 24)}...」がログに残った`);
  }
}

// 1. 鍵らしいフィールド名は値ごと伏せる
assertGone("鍵フィールド", FAKE, Object.values(FAKE));

// 2. 入れ子でも伏せる（ProcessPayment の入力を模したもの）
assertGone(
  "入れ子",
  {
    paymentInput: {
      cryptoX402: { payload: { signature: "0xabc", authorization: { privateKey: FAKE.privateKey } } },
    },
    providerConfigurationInput: {
      coinbaseCdpConfiguration: {
        apiKeyId: "visible-key-id",
        apiKeySecret: FAKE.apiKeySecret,
        walletSecret: FAKE.walletSecret,
      },
    },
  },
  [FAKE.privateKey, FAKE.apiKeySecret, FAKE.walletSecret],
);

// 3. フィールド名が無害でも、値が 32byte hex なら伏せる
const sneaky = redact({ memo: FAKE.privateKey }) as { memo: string };
if (sneaky.memo !== REDACTED) problems.push("無害な名前に隠した秘密鍵が素通りした");

// 4. ただし tx hash / nonce は伏せない（8節の採取必須項目）
const tx = "0xf43cec285e9fffd8ddc03aaf7decca65570f37e5ad0f80547b25921b1410e06e";
for (const key of ["reference", "transaction", "nonce"]) {
  const out = redact({ [key]: tx }) as Record<string, string>;
  if (out[key] !== tx) problems.push(`${key} が伏せられた（tx参照は残さないといけない）`);
}

// 5. 支払いヘッダは構造だけ残る
const masked = maskHeaderValue("X-PAYMENT", "eyJ4NDAyVmVyc2lvbiI6MSwic2NoZW1lIjoiZXhhY3QifQ==");
if (masked.includes("eyJ4NDAy")) problems.push("X-PAYMENT の値が masked されていない");
if (!masked.includes("masked")) problems.push("X-PAYMENT の masked 表記が無い");
const mppMasked = maskHeaderValue("Authorization", "Payment eyJjaGFsbGVuZ2UiOnt9fQ");
if (!mppMasked.startsWith("Payment ") || mppMasked.includes("eyJjaGFs")) {
  problems.push("Authorization: Payment の値が masked されていない");
}

// 6. スキャナ自身が「伏せ忘れ」を検出できるか（偽陰性の確認）
const leaked = JSON.stringify({ walletSecret: FAKE.walletSecret });
if (findKeyMaterial(leaked).length === 0) {
  problems.push("findKeyMaterial が伏せ忘れを見逃した");
}
const clean = JSON.stringify(redact({ walletSecret: FAKE.walletSecret }));
if (findKeyMaterial(clean).length !== 0) {
  problems.push("findKeyMaterial が正しく伏せた値を誤検出した");
}

if (problems.length > 0) {
  console.error("NG:\n" + problems.map((p) => ` - ${p}`).join("\n"));
  process.exit(1);
}
console.log(
  JSON.stringify(
    {
      check: "redaction",
      result: "ok",
      note: "偽の鍵素材を6パターン流し、すべて伏せられること／tx参照は残ることを確認",
    },
    null,
    2,
  ),
);

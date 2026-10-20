/**
 * 鍵素材がどのログにも出ていないことの確認（AC-1〜AC-4 で足した項目）。
 *
 * check:secrets（既存）は artifacts 配下の JSON/JSONL を形で見る。ここではそれに加えて:
 *   1. artifacts/ と docs/ の**全テキストファイル**（.json .jsonl .md .csv .txt .log）を見る
 *      （Python 側が書いたログ、AC-4 の CSV、結果表の Markdown も対象）
 *   2. 実行環境に置かれている秘密らしい env の**値そのもの**が、どこかに書き出されていないかを見る
 *      （例: CDP_API_KEY_SECRET、PRIVY_APP_SECRET、AWS_SECRET_ACCESS_KEY、*_KEYPAIR）。
 *      値は表示しない。ヒットしたら env 名とファイル名だけを出す。
 *   3. 自己確認: 偽の秘密 env をつくって一時ファイルに書き、検出できることを先に確かめる（空振りの検査にしない）
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { findKeyMaterial } from "../src/guard/redact.js";

const TEXT_EXT = [".json", ".jsonl", ".md", ".csv", ".txt", ".log"];
const SECRET_ENV_NAME =
  /(SECRET|PRIVATE|KEYPAIR|MNEMONIC|SEED|PASSWORD|API_KEY|ACCESS_KEY|AUTH_TOKEN|SESSION_TOKEN|WALLET)/i;
/** 秘密ではないことが分かっている env（ID・公開値） */
const NOT_SECRET = new Set(["AWS_ACCESS_KEY_ID", "CDP_API_KEY_ID", "PRIVY_APP_ID", "PRIVY_AUTHORIZATION_ID", "AGENTCORE_WALLET_ADDRESS"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (TEXT_EXT.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

/** 照合する秘密値。値は返り値の中にだけ置き、表示しない。 */
function secretValues(env: NodeJS.ProcessEnv): Array<{ name: string; needles: string[] }> {
  const out: Array<{ name: string; needles: string[] }> = [];
  for (const [name, v] of Object.entries(env)) {
    if (!v || NOT_SECRET.has(name) || !SECRET_ENV_NAME.test(name)) continue;
    const value = v.trim();
    if (value.length < 12) continue;
    const needles = new Set([value]);
    // JSON 配列の鍵（Solana keypair 等）は空白の有無で表記が揺れる
    if (value.startsWith("[")) needles.add(value.replace(/\s+/g, ""));
    // PEM は 1 行目と最後の行を除いた本体の先頭 40 文字でも探す（改行の揺れに強くする）
    const pem = /-----BEGIN [A-Z ]+-----([\s\S]+?)-----END/.exec(value);
    if (pem?.[1]) needles.add(pem[1].replace(/\s+/g, "").slice(0, 40));
    // 長い値は先頭 24 文字の断片でも探す（切り詰めて書き出された場合）
    if (value.length >= 48) needles.add(value.slice(0, 24));
    out.push({ name, needles: [...needles] });
  }
  return out;
}

interface Hit {
  file: string;
  line?: number;
  kind: "pattern" | "env-value";
  detail: string;
}

function scan(roots: string[], env: NodeJS.ProcessEnv): { files: number; records: number; envChecked: string[]; hits: Hit[] } {
  const files = roots.flatMap((r) => walk(resolve(r)));
  const secrets = secretValues(env);
  const hits: Hit[] = [];
  let records = 0;
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const s of secrets) {
      if (s.needles.some((n) => content.includes(n))) {
        hits.push({ file, kind: "env-value", detail: `env ${s.name} の値が書き出されている` });
      }
    }
    if (file.endsWith(".jsonl")) {
      content.split("\n").filter(Boolean).forEach((line, i) => {
        records += 1;
        for (const h of findKeyMaterial(line)) hits.push({ file, line: i + 1, kind: "pattern", detail: h });
      });
    } else if (file.endsWith(".json")) {
      records += 1;
      for (const h of findKeyMaterial(content)) hits.push({ file, kind: "pattern", detail: h });
    } else {
      records += 1;
      // Markdown / CSV / テキスト: 構造が無いので PEM 形の秘密鍵だけを形で見る
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)) {
        hits.push({ file, kind: "pattern", detail: "PEM の秘密鍵" });
      }
    }
  }
  return { files: files.length, records, envChecked: secrets.map((s) => s.name), hits };
}

// ---- 3. 自己確認: 偽の秘密を流して検出できること ----
const dir = mkdtempSync(join(tmpdir(), "keys-canary-"));
const canary = `canary-${randomBytes(24).toString("hex")}`;
const canaryEnv = { CANARY_WALLET_SECRET: canary } as NodeJS.ProcessEnv;
writeFileSync(join(dir, "leak.md"), `# leaked\n\nvalue: ${canary.slice(0, 30)}\n`);
writeFileSync(join(dir, "clean.csv"), "a,b\n1,2\n");
const self = scan([dir], canaryEnv);
rmSync(dir, { recursive: true, force: true });
if (!(self.hits.length === 1 && self.hits[0]!.kind === "env-value")) {
  console.error("NG: 自己確認で偽の秘密を検出できなかった（検査が空振りしている）", self.hits);
  process.exit(1);
}

// ---- 1, 2. 本番 ----
const result = scan(["artifacts", "docs"], process.env);
if (result.hits.length > 0) {
  console.error(
    "NG: 鍵素材の疑いがある箇所（値は表示しない）\n" +
      JSON.stringify(result.hits.map((h) => ({ ...h, file: h.file.replace(process.cwd() + "/", "") })), null, 2),
  );
  process.exit(1);
}
console.log(
  JSON.stringify(
    {
      check: "keys-everywhere",
      result: "ok",
      self_test: "偽の秘密 env を検出できた",
      roots: ["artifacts", "docs"],
      files_scanned: result.files,
      records_scanned: result.records,
      secret_env_values_checked: result.envChecked,
    },
    null,
    2,
  ),
);

/**
 * 層1 の受け入れ条件: 「全ログを grep して鍵素材が出ないことを確認する」。
 * artifacts 配下の全 JSON/JSONL を走査する。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { findKeyMaterial } from "../src/guard/redact.js";

const root = resolve(process.argv[2] ?? "artifacts");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".json") || name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

const files = walk(root);
const problems: Array<{ file: string; line: number; hits: string[] }> = [];
let lines = 0;

for (const file of files) {
  const content = readFileSync(file, "utf8");
  if (file.endsWith(".jsonl")) {
    content.split("\n").filter(Boolean).forEach((line, i) => {
      lines += 1;
      const hits = findKeyMaterial(line);
      if (hits.length > 0) problems.push({ file, line: i + 1, hits });
    });
  } else {
    lines += 1;
    const hits = findKeyMaterial(content);
    if (hits.length > 0) problems.push({ file, line: 1, hits });
  }
}

if (problems.length > 0) {
  console.error("NG: 鍵素材の疑いがある箇所\n" + JSON.stringify(problems, null, 2));
  process.exit(1);
}
console.log(
  JSON.stringify(
    { check: "no-key-material", result: "ok", files_scanned: files.length, records_scanned: lines },
    null,
    2,
  ),
);

/**
 * T2 の受け入れ条件を機械的に検査する。
 *  1. TOOL_DEFS が discover と pay の 2 本だけであること
 *  2. dispatchTool が 3 本目を受け付けないこと
 *  3. ツール定義に鍵・上限・チェーンのパラメータが露出していないこと
 */
import { TOOL_DEFS, dispatchTool } from "../src/agent/tools.js";

const problems: string[] = [];

if (TOOL_DEFS.length !== 2) problems.push(`ツール本数が ${TOOL_DEFS.length}（期待 2）`);
const names = TOOL_DEFS.map((t) => t.name).sort();
if (JSON.stringify(names) !== JSON.stringify(["discover", "pay"])) {
  problems.push(`ツール名が ${names.join(",")}（期待 discover,pay）`);
}

const FORBIDDEN = ["key", "privatekey", "wallet", "signature", "limit", "max", "chain", "facilitator", "arn"];
const serialized = JSON.stringify(TOOL_DEFS).toLowerCase();
for (const word of FORBIDDEN) {
  // パラメータ名として現れていないかを見る（説明文の中の語は対象外）
  for (const t of TOOL_DEFS) {
    const props = Object.keys((t.input_schema.properties ?? {}) as Record<string, unknown>);
    const nested = props.flatMap((p) => {
      const schema = (t.input_schema.properties as Record<string, { properties?: Record<string, unknown> }>)[p];
      return Object.keys(schema?.properties ?? {});
    });
    for (const p of [...props, ...nested]) {
      if (p.toLowerCase().includes(word)) problems.push(`${t.name} のパラメータ ${p} に「${word}」が露出`);
    }
  }
}
void serialized;

try {
  await dispatchTool({} as never, "settle", {});
  problems.push("未知のツール settle が拒否されなかった");
} catch {
  // 期待どおり
}

if (problems.length > 0) {
  console.error("NG:\n" + problems.map((p) => ` - ${p}`).join("\n"));
  process.exit(1);
}
console.log(
  JSON.stringify(
    {
      check: "tool-surface",
      result: "ok",
      tool_count: TOOL_DEFS.length,
      tools: names,
      unknown_tool_rejected: true,
    },
    null,
    2,
  ),
);

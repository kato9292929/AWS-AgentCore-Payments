import type { DiscoverOptions } from "../tools/discover.js";
import { discover } from "../tools/discover.js";
import { pay, type PayDeps } from "../tools/pay.js";
import type { Rail } from "../types.js";

/**
 * モデル（LLM）に露出するツールはこの 2 つだけ。
 * 決済の中身（署名・鍵・チェーン・上限値）はツールの内側に隠す。
 *
 * この配列以外の経路でモデルにツールを渡さないこと。
 * 本数は scripts/check-tool-surface.ts が機械的に検査する。
 */
export const TOOL_DEFS = [
  {
    name: "discover",
    description:
      "課金エンドポイントを探す。クエリに合う候補を、価格 (price) と決済レール (rail) つきで返す。",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "探したいものの説明。空文字で全件。" },
      },
      required: ["query"],
    },
  },
  {
    name: "pay",
    description:
      "指定エンドポイントに対して支払いを1周する（402 を受け、支払い、再送して結果を取る）。" +
      "成功なら receipt の概要、拒否なら理由コード（limit_exceeded / not_approved など）を返す。",
    input_schema: {
      type: "object" as const,
      properties: {
        endpoint: { type: "string", description: "discover が返した endpoint。" },
        request: {
          type: "object" as const,
          description: "エンドポイントに渡すリクエスト指定（任意）。",
          properties: {
            rail: { type: "string", enum: ["x402", "mpp"] },
            method: { type: "string" },
          },
        },
      },
      required: ["endpoint"],
    },
  },
] as const;

if (TOOL_DEFS.length !== 2) {
  throw new Error(`モデルに露出するツールは 2 つでなければならない（現在 ${TOOL_DEFS.length}）`);
}

export type ToolName = (typeof TOOL_DEFS)[number]["name"];

export interface ToolContext {
  payDeps: PayDeps;
  discoverOpts: DiscoverOptions;
}

/** ツール名 → 実行。ここに 3 つ目を足さないこと。 */
export async function dispatchTool(
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "discover":
      return discover(ctx.payDeps.rec, String(input["query"] ?? ""), ctx.discoverOpts);
    case "pay":
      return pay(
        ctx.payDeps,
        String(input["endpoint"] ?? ""),
        (input["request"] ?? {}) as { rail?: Rail; method?: string },
      );
    default:
      // モデルが知らないツールを名乗っても、ここで確実に落ちる。
      throw new Error(`未知のツール: ${name}`);
  }
}

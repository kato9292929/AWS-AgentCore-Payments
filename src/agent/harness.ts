import type { Recorder } from "../log/recorder.js";
import type { Planner } from "./planner.js";
import { dispatchTool, TOOL_DEFS, type ToolContext } from "./tools.js";

export interface SessionResult {
  runId: string;
  steps: number;
  finalText: string;
  toolCalls: Array<{ name: string; input: unknown; result: unknown }>;
}

/**
 * 1 セッション ＝ discover から success（または declined）までの 1 サイクル。
 * セッションを抜けるときにバックエンドの鍵・セッションを必ず閉じる。
 */
export async function runSession(
  rec: Recorder,
  planner: Planner,
  ctx: ToolContext,
  maxSteps = 6,
): Promise<SessionResult> {
  rec.event("session.start", {
    planner: planner.kind,
    tools_exposed_to_model: TOOL_DEFS.map((t) => t.name),
    tool_count: TOOL_DEFS.length,
  });

  const toolCalls: SessionResult["toolCalls"] = [];
  let results: Array<{ id: string; result: unknown }> = [];
  let finalText = "";
  let steps = 0;

  while (steps < maxSteps) {
    steps += 1;
    const step = await planner.next(results);
    if (step.text) rec.event("model.text", { text: step.text.slice(0, 500) });
    if (step.done || step.calls.length === 0) {
      finalText = step.text;
      break;
    }

    results = [];
    for (const call of step.calls) {
      rec.event("model.tool_use", { name: call.name, input: call.input });
      const result = await dispatchTool(ctx, call.name, call.input);
      toolCalls.push({ name: call.name, input: call.input, result });
      rec.event("model.tool_result", { name: call.name, result });
      results.push({ id: call.id, result });
    }
  }

  rec.event("session.end", { steps, finalText: finalText.slice(0, 500) });
  return { runId: rec.runId, steps, finalText, toolCalls };
}

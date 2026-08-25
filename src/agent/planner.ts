import Anthropic from "@anthropic-ai/sdk";
import { TOOL_DEFS } from "./tools.js";

export interface PlannedCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface PlannerStep {
  /** ツールを呼ぶなら calls、終わりなら text。 */
  calls: PlannedCall[];
  text: string;
  done: boolean;
}

export interface Planner {
  readonly kind: string;
  next(toolResults: Array<{ id: string; result: unknown }>): Promise<PlannerStep>;
}

/**
 * 実 LLM。ツールは TOOL_DEFS の 2 つだけを渡す。
 * 決済の中身（鍵・上限・チェーン）はプロンプトにもツール定義にも出てこない。
 */
export class AnthropicPlanner implements Planner {
  readonly kind = "anthropic";
  private readonly client: Anthropic;
  private readonly messages: Anthropic.MessageParam[] = [];

  constructor(
    private readonly goal: string,
    private readonly model = process.env["ANTHROPIC_MODEL"] ?? "claude-sonnet-4-5",
  ) {
    this.client = new Anthropic();
    this.messages.push({ role: "user", content: goal });
  }

  async next(toolResults: Array<{ id: string; result: unknown }>): Promise<PlannerStep> {
    if (toolResults.length > 0) {
      this.messages.push({
        role: "user",
        content: toolResults.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.id,
          content: JSON.stringify(r.result),
        })),
      });
    }

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system:
        "あなたは買い手エージェント。使えるツールは discover と pay の 2 つだけ。" +
        "pay が needs_approval や declined を返したら、その理由を報告して終了する。" +
        "同じエンドポイントへ繰り返し支払わない。",
      tools: TOOL_DEFS as unknown as Anthropic.Tool[],
      messages: this.messages,
    });

    this.messages.push({ role: "assistant", content: res.content });

    const calls: PlannedCall[] = [];
    let text = "";
    for (const block of res.content) {
      if (block.type === "text") text += block.text;
      if (block.type === "tool_use") {
        calls.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
      }
    }
    return { calls, text, done: calls.length === 0 };
  }
}

/**
 * LLM API キーが無い環境でも 1 セッションを完走させるための決定論プランナ。
 * ツール発行の経路は AnthropicPlanner と同一（dispatchTool を通る）。
 * 「モデルがどう考えたか」は検証対象ではなく、2 ツール面と 402 一周が検証対象なので、
 * ここを差し替えても T2〜T7 の受け入れ条件は変わらない。
 */
export class ScriptedPlanner implements Planner {
  readonly kind = "scripted";
  private step = 0;
  private lastCandidates: Array<{ endpoint: string; rail: string; price: string }> = [];
  private readonly outcomes: string[] = [];
  /** 支払い対象の列。複数指定すると順に pay を呼ぶ（承認範囲の検証などに使う）。 */
  private readonly endpoints: string[];

  constructor(
    private readonly query: string,
    private readonly target: { rail?: string; endpoint?: string; endpoints?: string[] },
  ) {
    this.endpoints = target.endpoints ?? (target.endpoint ? [target.endpoint] : []);
  }

  async next(toolResults: Array<{ id: string; result: unknown }>): Promise<PlannerStep> {
    for (const r of toolResults) {
      if (Array.isArray(r.result)) {
        this.lastCandidates = r.result as typeof this.lastCandidates;
      } else if (r.result && typeof r.result === "object" && "status" in r.result) {
        this.outcomes.push(String((r.result as { status: unknown }).status));
      }
    }

    this.step += 1;
    if (this.step === 1) {
      return {
        calls: [{ id: "call_1", name: "discover", input: { query: this.query } }],
        text: "",
        done: false,
      };
    }

    // step 2 以降は、指定された endpoint を 1 件ずつ payする。
    const index = this.step - 2;
    const explicit = this.endpoints[index];
    const endpoint =
      explicit ??
      (index === 0
        ? (this.lastCandidates.find((c) => c.rail === this.target.rail)?.endpoint ??
          this.lastCandidates[0]?.endpoint)
        : undefined);

    if (!endpoint) {
      if (this.outcomes.length === 0) return { calls: [], text: "候補が見つからなかった", done: true };
      return { calls: [], text: `完了: status=${this.outcomes.join(",")}`, done: true };
    }

    return {
      calls: [
        {
          id: `call_${this.step}`,
          name: "pay",
          input: { endpoint, request: this.target.rail ? { rail: this.target.rail } : {} },
        },
      ],
      text: "",
      done: false,
    };
  }
}

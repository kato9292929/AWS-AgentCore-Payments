import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../guard/redact.js";

export interface RecorderOptions {
  runId: string;
  dir: string;
  /** true ならログを標準出力にも流す。 */
  echo?: boolean;
}

/**
 * 全 HTTP 往復・上限判定・承認ログを構造化 JSON で保存する。
 * 書き込みは必ず redact() を通す（層1の出口側）。
 */
export class Recorder {
  readonly runId: string;
  readonly dir: string;
  private readonly file: string;
  private readonly echo: boolean;
  private seq = 0;

  constructor(opts: RecorderOptions) {
    this.runId = opts.runId;
    this.dir = opts.dir;
    this.echo = opts.echo ?? false;
    mkdirSync(this.dir, { recursive: true });
    this.file = join(this.dir, "events.jsonl");
  }

  event(type: string, payload: Record<string, unknown>): void {
    const rec = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      runId: this.runId,
      type,
      ...(redact(payload) as Record<string, unknown>),
    };
    appendFileSync(this.file, `${JSON.stringify(rec)}\n`, "utf8");
    if (this.echo) {
      process.stderr.write(`[${rec.seq}] ${type} ${JSON.stringify(rec).slice(0, 400)}\n`);
    }
  }

  writeJson(name: string, data: unknown): string {
    const path = join(this.dir, name);
    writeFileSync(path, `${JSON.stringify(redact(data), null, 2)}\n`, "utf8");
    return path;
  }
}

import type { LLM, ToolSpec } from "./llm.js";
import type { ChatMessage, ToolCall } from "./types.js";
import { Inbox } from "./queue.js";
import { parseArgs } from "./tools.js";

export type ToolHandler = (name: string, args: Record<string, unknown>, call: ToolCall) => Promise<string>;

/**
 * Asynchronous ReAct session (§4.1). Events queue in the inbox while the model
 * is thinking and are merged into the next turn (batching, §2.1). Long tools
 * return "Started" immediately, so the session never blocks on them.
 */
export class AgentSession {
  readonly inbox = new Inbox<string>();
  busy = false;
  steps = 0;
  constructor(
    readonly id: string,
    readonly llm: LLM,
    readonly tools: ToolSpec[],
    readonly messages: ChatMessage[],
    private readonly handle: ToolHandler,
    private readonly maxInnerSteps = 8,
  ) {}

  /** Process one batch of queued events. Returns batch size (0 if nothing). */
  async step(): Promise<number> {
    if (this.busy || this.inbox.size === 0) return 0;
    this.busy = true;
    try {
      const batch = this.inbox.drainNow();
      this.messages.push({
        role: "user",
        content: batch.length === 1 ? batch[0]! : batch.map((b, i) => `### Event ${i + 1}\n${b}`).join("\n\n"),
      });
      for (let i = 0; i < this.maxInnerSteps; i++) {
        this.steps++;
        const res = await this.llm.chat(this.messages, this.tools);
        this.messages.push({
          role: "assistant",
          content: res.content,
          ...(res.toolCalls.length ? { tool_calls: res.toolCalls } : {}),
        });
        if (res.toolCalls.length === 0) break;
        for (const call of res.toolCalls) {
          let out: string;
          try {
            out = await this.handle(call.function.name, parseArgs(call.function.arguments), call);
          } catch (e) {
            out = `Error: ${(e as Error).message}`;
          }
          this.messages.push({ role: "tool", tool_call_id: call.id, content: out });
        }
      }
      return batch.length;
    } finally {
      this.busy = false;
    }
  }
}

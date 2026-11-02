import type { ChatMessage, ToolCall } from "./types.js";

/** Provider-agnostic LLM interface. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
}

export interface LLM {
  chat(messages: ChatMessage[], tools?: ToolSpec[]): Promise<LLMResponse>;
}

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  fetchImpl?: typeof fetch;
}

/** Works with any OpenAI-compatible /chat/completions endpoint. */
export class OpenAICompatibleLLM implements LLM {
  constructor(private readonly opts: OpenAICompatibleOptions) {}

  async chat(messages: ChatMessage[], tools?: ToolSpec[]): Promise<LLMResponse> {
    const f = this.opts.fetchImpl ?? fetch;
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages,
      temperature: this.opts.temperature ?? 0.2,
    };
    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({ type: "function", function: t }));
    }
    const res = await f(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
    };
    const msg = json.choices?.[0]?.message;
    return { content: msg?.content ?? "", toolCalls: msg?.tool_calls ?? [] };
  }
}

export function llmFromEnv(role: "router" | "worker" | "watchdog", env = process.env): LLM {
  const baseUrl = env.LLM_BASE_URL ?? "https://api.openai.com/v1";
  const model =
    (role === "router" ? env.ROUTER_MODEL : role === "worker" ? env.WORKER_MODEL : env.WATCHDOG_MODEL) ??
    env.LLM_MODEL ??
    "gpt-4o-mini";
  return new OpenAICompatibleLLM({ baseUrl, apiKey: env.LLM_API_KEY, model });
}

/** Scripted LLM for tests and offline demos. */
export class ScriptedLLM implements LLM {
  public calls: ChatMessage[][] = [];
  constructor(private readonly script: (messages: ChatMessage[], n: number) => LLMResponse) {}
  async chat(messages: ChatMessage[]): Promise<LLMResponse> {
    this.calls.push(messages.map((m) => ({ ...m })));
    return this.script(messages, this.calls.length - 1);
  }
}

export function toolCall(name: string, args: unknown, id = `call_${Math.random().toString(36).slice(2, 8)}`): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

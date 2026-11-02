import { describe, expect, it } from "vitest";
import {
  SuperAgent, ScriptedLLM, toolCall, FakeEnvironment, fastPath, inlineOrSpill, renderObject,
  formatForChannel, Inbox, AgentSession, Watchdog, emptySnapshot, MemoryStore, OpenAICompatibleLLM,
  type ChatMessage,
} from "../src/index.js";

const last = (m: ChatMessage[]) => m[m.length - 1]!;
const lastUser = (m: ChatMessage[]) => [...m].reverse().find((x) => x.role === "user")!.content;

function makeRouter() {
  return new ScriptedLLM((msgs) => {
    if (last(msgs).role === "tool") return { content: "", toolCalls: [] };
    const u = lastUser(msgs);
    if (u.includes("Incoming trigger")) {
      const key = /thread: (\S+)/.exec(u)?.[1] ?? "x";
      return { content: "", toolCalls: [toolCall("dispatch", { task: "fix bug", threadKey: key })] };
    }
    if (/Worker \S+ done/.test(u)) return { content: "", toolCalls: [toolCall("reply", { channel: "im", threadKey: "t1", text: "Fixed, PR opened." })] };
    return { content: "", toolCalls: [] };
  });
}
function makeWorker() {
  return new ScriptedLLM((msgs) => {
    if (last(msgs).role === "tool") return { content: "", toolCalls: [] };
    const u = lastUser(msgs);
    if (u.startsWith("Your task")) return { content: "", toolCalls: [toolCall("start", { command: "npm test" })] };
    if (u.includes("finished (exit 0)")) return { content: "", toolCalls: [toolCall("finish", { summary: "tests pass" })] };
    return { content: "", toolCalls: [] };
  });
}

describe("two-level architecture", () => {
  it("routes new task through router, worker runs async job, router replies", async () => {
    const agent = await new SuperAgent({ routerLLM: makeRouter(), workerLLM: makeWorker(), environments: [new FakeEnvironment()] }).init();
    expect(await agent.ingest({ channel: "im", source: "team", threadKey: "t1", author: "ann", text: "@bot the build is broken", mentionsAgent: true })).toBe("router");
    await agent.runUntilIdle();
    expect(agent.outbox).toEqual([{ channel: "im", threadKey: "t1", text: "Fixed, PR opened." }]);
    expect(Object.values(agent.state.workers)[0]!.status).toBe("done");
  });

  it("passes follow-up events straight through to subscribed worker", async () => {
    const worker = new ScriptedLLM(() => ({ content: "", toolCalls: [] }));
    const agent = await new SuperAgent({ routerLLM: makeRouter(), workerLLM: worker, environments: [new FakeEnvironment()] }).init();
    agent.dispatch("review PR", "pr-42");
    await agent.runUntilIdle();
    const routed = await agent.ingest({ channel: "github", source: "repo", threadKey: "pr-42", author: "bob", text: "please add tests", mentionsAgent: true });
    expect(routed).toBe("passthrough");
    await agent.runUntilIdle();
    expect(lastUser(worker.calls.at(-1)!)).toContain("please add tests");
  });

  it("without pass-through, follow-ups go to the router (ablation)", async () => {
    const agent = await new SuperAgent({ routerLLM: new ScriptedLLM(() => ({ content: "", toolCalls: [] })), workerLLM: makeWorker(), environments: [new FakeEnvironment()], passThrough: false }).init();
    agent.dispatch("review PR", "pr-1");
    expect(await agent.ingest({ channel: "github", source: "r", threadKey: "pr-1", author: "b", text: "hi", mentionsAgent: true })).toBe("router");
  });
});

describe("event filtering", () => {
  const policy = { sources: { general: "explicit-only" as const, bugs: "candidate" as const, spam: "ignore" as const }, defaultMode: "ignore" as const };
  const t = (source: string, mentionsAgent = false) => ({ id: "1", channel: "im" as const, source, threadKey: "k", author: "a", text: "x", mentionsAgent, timestamp: 0 });
  it("fast path", () => {
    expect(fastPath(t("general"), policy)).toBe("drop");
    expect(fastPath(t("general", true), policy)).toBe("accept");
    expect(fastPath(t("bugs"), policy)).toBe("candidate");
    expect(fastPath(t("spam", true), policy)).toBe("drop");
  });
  it("slow path drops candidates the model ignores", async () => {
    const filter = new ScriptedLLM(() => ({ content: "IGNORE", toolCalls: [] }));
    const agent = await new SuperAgent({ routerLLM: makeRouter(), workerLLM: makeWorker(), filterLLM: filter, environments: [], fastPath: policy }).init();
    expect(await agent.ingest({ channel: "im", source: "bugs", threadKey: "k", author: "a", text: "lunch?" })).toBe("dropped");
  });
});

describe("context: inline & spill, chain of recall", () => {
  it("spills long content with a pointer", () => {
    const s = inlineOrSpill("trg_1", "a".repeat(100), 10);
    expect(s).toContain("spilled 90 chars");
    expect(s).toContain('recall("trg_1"');
  });
  it("inlines next-hop ids", () => {
    const st = emptySnapshot();
    st.workers.w1 = { id: "w1", task: "fix login", status: "running", threadIds: ["th1"], reports: [], createdAt: 0, lastProgressAt: 0, speculative: false };
    st.threads.th1 = { id: "th1", key: "pr-9", channel: "github", triggerIds: [], subscriberIds: ["w1"], summary: "login PR" };
    const r = renderObject(st, "th1");
    expect(r).toContain("w1: [running] fix login");
  });
});

describe("full-duplex session batching", () => {
  it("merges events queued during a turn", async () => {
    const llm = new ScriptedLLM(() => ({ content: "ok", toolCalls: [] }));
    const s = new AgentSession("s", llm, [], [], async () => "");
    s.inbox.push("a"); s.inbox.push("b"); s.inbox.push("c");
    expect(await s.step()).toBe(3);
    expect(llm.calls.length).toBe(1);
    expect(lastUser(llm.calls[0]!)).toContain("### Event 3");
  });
  it("inbox drain waits", async () => {
    const i = new Inbox<number>();
    setTimeout(() => i.push(1), 1);
    expect(await i.drain()).toEqual([1]);
  });
});

describe("channels, persistence, watchdog, llm", () => {
  it("caps IM replies at 100 words", () => {
    expect(formatForChannel("im", Array(150).fill("w").join(" ")).split(" ").length).toBe(100);
    expect(formatForChannel("github", "long ".repeat(200))).toHaveLength(1000);
  });
  it("state survives a restart (stateless compute)", async () => {
    const store = new MemoryStore();
    const a = await new SuperAgent({ routerLLM: makeRouter(), workerLLM: new ScriptedLLM(() => ({ content: "", toolCalls: [] })), environments: [], store }).init();
    const w = a.dispatch("long task", "t9");
    await a.persist();
    const b = await new SuperAgent({ routerLLM: makeRouter(), workerLLM: makeWorker(), environments: [], store }).init();
    expect(b.workers.has(w.id)).toBe(true);
  });
  it("watchdog nudges stalled workers", async () => {
    const a = await new SuperAgent({ routerLLM: makeRouter(), workerLLM: makeWorker(), environments: [] }).init();
    const w = a.dispatch("x", "t");
    a.workers.get(w.id)!.inbox.drainNow();
    const wd = new Watchdog(a, { stallMs: 10 });
    await wd.tick(Date.now() + 1000);
    expect(wd.alerts[0]).toContain("stalled");
    expect(a.workers.get(w.id)!.inbox.size).toBe(1);
  });
  it("OpenAI-compatible client parses tool calls", async () => {
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).model).toBe("m");
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [toolCall("reply", {}, "c1")] } }] }));
    }) as unknown as typeof fetch;
    const llm = new OpenAICompatibleLLM({ baseUrl: "http://x/v1/", model: "m", fetchImpl });
    const r = await llm.chat([{ role: "user", content: "hi" }], [{ name: "reply", description: "", parameters: {} }]);
    expect(r.toolCalls[0]!.id).toBe("c1");
  });
});

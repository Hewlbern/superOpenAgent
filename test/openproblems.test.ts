import { describe, expect, it } from "vitest";
import {
  SuperAgent, ScriptedLLM, toolCall, FakeEnvironment, MemoryStore, LongTermMemory, emptySnapshot,
  CredentialBroker, AgentBus, ShardedRouter, fnv1a, LocalIdentityProvider, didKeyFromPublicKey, base58btc,
  OpenIDClient, OpenIDIdentityProvider, OpenIDPodStore, envelopePayload, type ChatMessage,
} from "../src/index.js";

const last = (m: ChatMessage[]) => m[m.length - 1]!;
const lastUser = (m: ChatMessage[]) => [...m].reverse().find((x) => x.role === "user")!.content;
const quiet = () => new ScriptedLLM(() => ({ content: "", toolCalls: [] }));

describe("long-term memory", () => {
  it("remembers, recalls by keyword with tag weighting, and dedupes", () => {
    const s = emptySnapshot();
    const m = new LongTermMemory(() => s);
    m.remember("Deploys go out on Tuesdays via Railway", ["deploy"]);
    m.remember("Mike prefers short IM replies", ["style"]);
    m.remember("Deploys go out on Tuesdays via Railway");
    expect(m.size).toBe(2);
    expect(m.recall("when do we deploy?")[0]!.text).toContain("Railway");
    expect(m.recall("zzz")).toEqual([]);
    expect(s.memories).toHaveLength(2);
  });

  it("persists across restarts through the store and is usable as a tool", async () => {
    const store = new MemoryStore();
    const router = new ScriptedLLM((msgs) => {
      if (last(msgs).role === "tool") return { content: "", toolCalls: [] };
      return { content: "", toolCalls: [toolCall("remember", { text: "Repo uses pnpm", tags: ["tooling"] })] };
    });
    const a = await new SuperAgent({ routerLLM: router, workerLLM: quiet(), environments: [], store }).init();
    await a.ingest({ channel: "im", source: "s", threadKey: "t", author: "m", text: "fyi we use pnpm", mentionsAgent: true });
    await a.runUntilIdle();
    const b = await new SuperAgent({ routerLLM: quiet(), workerLLM: quiet(), environments: [], store }).init();
    expect(b.memory.recall("pnpm tooling")[0]!.text).toBe("Repo uses pnpm");
  });
});

describe("credential broker", () => {
  it("injects by name, enforces grants, and redacts", () => {
    const b = new CredentialBroker();
    b.register("GH_TOKEN", "ghp_supersecret123");
    b.register("DB", "pg://u:pw@h/db", ["w1"]);
    expect(b.inject("curl -H 'auth: {{secret:GH_TOKEN}}'")).toContain("ghp_supersecret123");
    expect(() => b.inject("{{secret:DB}}", "w2")).toThrow();
    expect(b.inject("{{secret:DB}}", "w1")).toBe("pg://u:pw@h/db");
    expect(b.redact("token=ghp_supersecret123")).toBe("token=[REDACTED:GH_TOKEN]");
    expect(b.redact(Buffer.from("ghp_supersecret123").toString("base64"))).toBe("[REDACTED:GH_TOKEN]");
    expect(b.names()).toEqual(["GH_TOKEN", "DB"]);
    expect(CredentialBroker.fromEnv({ SECRET_X: "abcd", OTHER: "1" }).names()).toEqual(["X"]);
  });

  it("the model never sees the raw secret, and state never stores it", async () => {
    const credentials = new CredentialBroker();
    credentials.register("API_KEY", "sk-live-0123456789");
    const worker = new ScriptedLLM((msgs) => {
      if (last(msgs).role === "tool") return { content: "", toolCalls: [] };
      const u = lastUser(msgs);
      if (u.startsWith("Your task")) return { content: "", toolCalls: [toolCall("start", { command: "deploy --key {{secret:API_KEY}}" })] };
      if (u.includes("finished")) return { content: "", toolCalls: [toolCall("finish", { summary: "ok" })] };
      return { content: "", toolCalls: [] };
    });
    const store = new MemoryStore();
    const agent = await new SuperAgent({ routerLLM: quiet(), workerLLM: worker, environments: [new FakeEnvironment()], credentials, store }).init();
    agent.dispatch("deploy", "t");
    await agent.runUntilIdle();
    const seen = JSON.stringify(worker.calls);
    expect(seen).toContain("[REDACTED:API_KEY]");
    expect(seen).not.toContain("sk-live-0123456789");
    expect(JSON.stringify(await store.load())).not.toContain("sk-live-0123456789");
    expect(credentials.accessLog[0]!.granted).toBe(true);
  });
});

describe("identity", () => {
  it("issues Ed25519 identities with did:key and verifiable signatures", async () => {
    const p = new LocalIdentityProvider();
    const i = await p.issue("router");
    expect(i.didKey.startsWith("did:key:z6Mk")).toBe(true);
    expect(p.verify(i, "hello", p.sign(i.id, "hello"))).toBe(true);
    expect(p.verify(i, "hellp", p.sign(i.id, "hello"))).toBe(false);
    expect(base58btc(new Uint8Array([0, 0, 1]))).toBe("112");
    expect(didKeyFromPublicKey(new Uint8Array(32))).toMatch(/^did:key:z6Mk/);
  });

  it("gives the router and each worker an identity", async () => {
    const agent = await new SuperAgent({ routerLLM: quiet(), workerLLM: quiet(), environments: [], identity: new LocalIdentityProvider(), name: "atlas" }).init();
    const w = agent.dispatch("x", "t");
    await agent.runUntilIdle();
    expect(agent.identity!.name).toBe("atlas");
    expect(agent.state.identity!.webId).toContain("atlas");
    expect(w.identity!.name).toBe(`worker-${w.id}`);
  });

  it("OpenID client: registers agents, signs requests, persists state to the pod (mock server)", async () => {
    const files = new Map<string, string>();
    const fake: typeof fetch = async (url, init) => {
      const u = new URL(String(url));
      if (u.pathname === "/agents") return new Response(JSON.stringify({ agent: { id: "a1", name: "r", webId: "http://x/agent-a1/profile/card#me", podPath: "agent-a1/", publicKey: "pk", didKey: "did:key:z6Mk" }, token: "tok" }), { status: 201 });
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      if (init?.method === "PUT") { files.set(u.pathname, String(init.body)); return new Response("", { status: 201 }); }
      const f = files.get(u.pathname);
      return f ? new Response(f) : new Response("", { status: 404 });
    };
    const provider = new OpenIDIdentityProvider(new OpenIDClient("http://x", fake));
    const agent = await new SuperAgent({ routerLLM: quiet(), workerLLM: quiet(), environments: [], identity: provider, storeFor: (i) => new OpenIDPodStore(provider, i) }).init();
    agent.memory.remember("pod-backed fact");
    await agent.persist();
    expect(files.get("/agent-a1/superagent/state.json")).toContain("pod-backed fact");
  });
});

describe("agent-to-agent messaging", () => {
  it("delivers signed messages between instances and replies route back", async () => {
    const ids = new LocalIdentityProvider();
    const bus = new AgentBus(ids);
    const askRouter = new ScriptedLLM((msgs) => {
      if (last(msgs).role === "tool") return { content: "", toolCalls: [] };
      const u = lastUser(msgs);
      if (u.includes("please ask ops")) return { content: "", toolCalls: [toolCall("message_agent", { to: "ops", threadKey: "q1", text: "Is prod healthy?" })] };
      return { content: "", toolCalls: [] };
    });
    const opsRouter = new ScriptedLLM((msgs) => {
      if (last(msgs).role === "tool") return { content: "", toolCalls: [] };
      if (lastUser(msgs).includes("Is prod healthy?")) return { content: "", toolCalls: [toolCall("reply", { channel: "agent", threadKey: "q1", text: "Yes, all green." })] };
      return { content: "", toolCalls: [] };
    });
    const dev = await new SuperAgent({ name: "dev", routerLLM: askRouter, workerLLM: quiet(), environments: [], bus, identity: ids }).init();
    const ops = await new SuperAgent({ name: "ops", routerLLM: opsRouter, workerLLM: quiet(), environments: [], bus, identity: ids }).init();
    await dev.ingest({ channel: "im", source: "s", threadKey: "t", author: "m", text: "please ask ops", mentionsAgent: true });
    for (let i = 0; i < 3; i++) { await dev.runUntilIdle(); await ops.runUntilIdle(); }
    expect(bus.log.map((e) => e.text)).toEqual(["Is prod healthy?", "Yes, all green."]);
    expect(JSON.stringify(askRouter.calls.at(-1))).toContain("Yes, all green.");
    const forged = { from: dev.identity!.id, to: "ops", threadKey: "q1", text: "evil", sentAt: 1, signature: "AAAA" };
    expect(await bus.send(forged)).toBe("Rejected: bad signature");
    expect(envelopePayload(forged)).toContain("evil");
  });
});

describe("router sharding", () => {
  it("routes a thread consistently to one shard, supports channel sharding and pins", async () => {
    const mk = () => new SuperAgent({ routerLLM: quiet(), workerLLM: quiet(), environments: [] }).init();
    const shards = await Promise.all([mk(), mk(), mk()]);
    const r = new ShardedRouter(shards, "thread");
    const t = { channel: "github" as const, threadKey: "pr-7" };
    expect(r.shardFor(t)).toBe(r.shardFor(t));
    expect(r.shardFor(t)).toBe(fnv1a("github:pr-7") % 3);
    const spread = new Set(Array.from({ length: 30 }, (_, i) => r.shardFor({ channel: "im", threadKey: `t${i}` })));
    expect(spread.size).toBe(3);
    await r.ingest({ channel: "github", source: "s", threadKey: "pr-7", author: "a", text: "hi", mentionsAgent: true });
    const owner = shards[r.shardFor(t)]!;
    expect(Object.values(owner.state.threads).map((x) => x.key)).toContain("pr-7");
    const byChannel = new ShardedRouter(shards, "channel", { email: 2 });
    expect(byChannel.shardFor({ channel: "email", threadKey: "x" })).toBe(2);
    expect(byChannel.shardFor({ channel: "im", threadKey: "a" })).toBe(byChannel.shardFor({ channel: "im", threadKey: "b" }));
    await r.runUntilIdle();
  });
});

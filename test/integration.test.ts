import { describe, expect, it } from "vitest";
import { SuperAgent, FakeEnvironment, llmFromEnv, ScriptedLLM, OpenIDClient, OpenIDIdentityProvider, OpenIDPodStore, MemoryStore } from "../src/index.js";

/** Real-model smoke test. Runs only when LLM_API_KEY is set (any OpenAI-compatible endpoint). */
describe.skipIf(!process.env.LLM_API_KEY)("real LLM (LLM_API_KEY)", () => {
  it("router dispatches and replies end to end", async () => {
    const agent = await new SuperAgent({ routerLLM: llmFromEnv("router"), workerLLM: llmFromEnv("worker"), environments: [new FakeEnvironment()], store: new MemoryStore() }).init();
    await agent.ingest({ channel: "im", source: "team", threadKey: "smoke", author: "mike", text: "@bot please run `echo hello` and tell me the output", mentionsAgent: true });
    await agent.runUntilIdle(60);
    expect(Object.keys(agent.state.workers).length + agent.outbox.length).toBeGreaterThan(0);
  }, 180_000);
});

/** Live OpenID server test. Runs only when OPENID_BASE_URL is set (e.g. `go run ./cmd/server -port 3000`). */
describe.skipIf(!process.env.OPENID_BASE_URL)("live OpenID server (OPENID_BASE_URL)", () => {
  it("registers identities, signs requests and round-trips state through the pod", async () => {
    const client = new OpenIDClient(process.env.OPENID_BASE_URL!);
    expect(await client.health()).toBe(true);
    const provider = new OpenIDIdentityProvider(client);
    const quiet = new ScriptedLLM(() => ({ content: "", toolCalls: [] }));
    const a = await new SuperAgent({ routerLLM: quiet, workerLLM: quiet, environments: [], identity: provider, storeFor: (i) => new OpenIDPodStore(provider, i) }).init();
    expect(a.identity!.webId).toMatch(/profile\/card#me$/);
    a.memory.remember("stored in a Solid pod", ["openid"]);
    await a.persist();
    const store = new OpenIDPodStore(provider, a.identity!);
    expect((await store.load()).memories![0]!.text).toBe("stored in a Solid pod");
    const path = `${a.identity!.podPath}superagent/signed.json`;
    await client.put(path, '{"ok":true}', provider.auth(a.identity!.id, "PUT", path, true));
    expect(await client.get(path, provider.auth(a.identity!.id))).toBe('{"ok":true}');
  }, 30_000);
});

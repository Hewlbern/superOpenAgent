/**
 * Scripted end-to-end demo (no API key needed): `npm run demo`.
 * Shows routing, async worker jobs, pass-through, the credential broker,
 * long-term memory, identities, agent-to-agent messaging and router sharding.
 */
import {
  SuperAgent, ScriptedLLM, toolCall, FakeEnvironment, CredentialBroker, LocalIdentityProvider, AgentBus, ShardedRouter,
  type ChatMessage,
} from "../src/index.js";

const last = (m: ChatMessage[]) => m[m.length - 1]!;
const lastUser = (m: ChatMessage[]) => [...m].reverse().find((x) => x.role === "user")?.content ?? "";
const log = (s: string) => console.log(s);

const router = new ScriptedLLM((msgs) => {
  if (last(msgs).role === "tool") return { content: "", toolCalls: [] };
  const u = lastUser(msgs);
  if (u.includes("Incoming trigger") && u.includes("deploy")) return { content: "", toolCalls: [toolCall("remember", { text: "Mike deploys from the release branch", tags: ["deploy"] }), toolCall("dispatch", { task: "Deploy the app", threadKey: "deploy-1" })] };
  if (u.includes("Incoming trigger") && u.includes("status")) return { content: "", toolCalls: [toolCall("message_agent", { to: "ops", threadKey: "status", text: "Status of prod?" })] };
  if (/Worker \S+ done/.test(u)) return { content: "", toolCalls: [toolCall("reply", { channel: "im", threadKey: "deploy-1", text: "Deployed ✅ (logs redacted)." })] };
  return { content: "", toolCalls: [] };
});
const worker = new ScriptedLLM((msgs) => {
  if (last(msgs).role === "tool") return { content: "", toolCalls: [] };
  const u = lastUser(msgs);
  if (u.startsWith("Your task")) return { content: "", toolCalls: [toolCall("start", { command: "deploy --token {{secret:DEPLOY_TOKEN}}" })] };
  if (u.includes("finished")) { log(`  worker saw job output: ${u.split("\n")[1]}`); return { content: "", toolCalls: [toolCall("finish", { summary: "deployed" })] }; }
  return { content: "", toolCalls: [] };
});
const ops = new ScriptedLLM((msgs) => {
  if (last(msgs).role === "tool") return { content: "", toolCalls: [] };
  if (lastUser(msgs).includes("Status of prod?")) return { content: "", toolCalls: [toolCall("reply", { channel: "agent", threadKey: "status", text: "prod: all green" })] };
  return { content: "", toolCalls: [] };
});

const credentials = new CredentialBroker();
credentials.register("DEPLOY_TOKEN", "tok_live_9f8e7d6c5b");
const identity = new LocalIdentityProvider("urn:demo");
const bus = new AgentBus(identity);
const idle = new ScriptedLLM(() => ({ content: "", toolCalls: [] }));

const dev = await new SuperAgent({ name: "dev", routerLLM: router, workerLLM: worker, environments: [new FakeEnvironment()], credentials, identity, bus, onOutbound: (m) => log(`  → ${m.channel}:${m.threadKey}: ${m.text}`) }).init();
const opsAgent = await new SuperAgent({ name: "ops", routerLLM: ops, workerLLM: idle, environments: [], identity, bus }).init();
log(`dev identity: ${dev.identity!.didKey}`);

const sharded = new ShardedRouter([dev], "thread");
log("1) IM: '@bot deploy please'");
await sharded.ingest({ channel: "im", source: "team", threadKey: "deploy-1", author: "mike", text: "@bot deploy please", mentionsAgent: true });
await dev.runUntilIdle();
log(`  memory: ${dev.memory.recall("deploy").map((f) => f.text).join("; ")}`);
log(`  worker identity: ${Object.values(dev.state.workers)[0]!.identity!.webId}`);

log("2) IM: '@bot what is prod status?' -> asks the ops agent");
await dev.ingest({ channel: "im", source: "team", threadKey: "q", author: "mike", text: "@bot what is prod status?", mentionsAgent: true });
for (let i = 0; i < 3; i++) { await dev.runUntilIdle(); await opsAgent.runUntilIdle(); }
log(`  a2a log: ${bus.log.map((e) => `${e.from.split("-")[0]}→${e.to.split("-")[0]}: ${e.text}`).join(" | ")}`);
log(`secret ever shown to a model? ${JSON.stringify(worker.calls).includes("tok_live_9f8e7d6c5b")}`);

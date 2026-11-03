/**
 * Identity + state on an OpenID Solid server (https://github.com/Hewlbern/openID).
 *   go run ./cmd/server -port 3000   # in the openID repo
 *   OPENID_BASE_URL=http://localhost:3000 npm run example:openid
 */
import { SuperAgent, ScriptedLLM, OpenIDClient, OpenIDIdentityProvider, OpenIDPodStore } from "../src/index.js";

const client = new OpenIDClient(process.env.OPENID_BASE_URL ?? "http://localhost:3000");
if (!(await client.health())) { console.error("OpenID server not reachable"); process.exit(1); }
const provider = new OpenIDIdentityProvider(client);
const idle = new ScriptedLLM(() => ({ content: "", toolCalls: [] }));
const agent = await new SuperAgent({ name: "router", routerLLM: idle, workerLLM: idle, environments: [], identity: provider, storeFor: (i) => new OpenIDPodStore(provider, i) }).init();
const w = agent.dispatch("example task", "t1");
await agent.runUntilIdle();
agent.memory.remember("This fact lives in a Solid pod", ["openid"]);
await agent.persist();
console.log({ router: agent.identity!.webId, did: agent.identity!.didKey, worker: w.identity?.webId, state: `${client.baseUrl}/${agent.identity!.podPath}superagent/state.json` });

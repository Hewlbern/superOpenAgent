# superOpenAgent

A TypeScript **Super-agent harness**: an implementation of the architecture described by the DeepSeek Harness team in
[“Exploring Super-agent Design: Towards a More Autonomous Agent System”](https://x.com/DeepSeekHarness/status/2116857257245987236)
(see also their prototype, [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)).

> This is an independent, unofficial implementation of the ideas. It is not affiliated with DeepSeek.

## The idea in one minute

Today's agents use **one session as the unit of work**. You can run maybe 3–5 sessions before *human attention* becomes the bottleneck.
A **Super-agent** is one continuous agent that lives where you already work (chat, GitHub, email), runs many tasks in parallel, acts
on events without being asked, and stays online. The post argues it should be:

- **Continuous** – always feels like one agent, across every channel.
- **Productive** – runs several complex tasks at once; takes new instructions mid-task.
- **Proactive** – watches events, acts on what matters, otherwise stays quiet.
- **Persistent** – always online, recovers from failures on its own.

No single ReAct loop gives you that, so it comes from five architectural modules:

| # | Module | What it does | In this repo |
|---|--------|--------------|--------------|
| 2 | **Two-level architecture** | A long-lived **Router** (talks to humans, dispatches, no shell) + isolated **Workers** (one task each, full tools, never talk to humans) | `src/superagent.ts` |
| 3 | **Event-driven Triggers** | Fast/Slow-path filtering, Thread subscription & **pass-through**, **Inline & Spill** context, **Chain of Recall**, speculative "act-ahead" | `src/filter.ts`, `src/context.ts`, `dispatch(..., speculative)` |
| 4 | **Full-duplex multi-channel** | Async `start()`/`stop()` tools so sessions never block; per-channel norms (IM ≤ 100 words) | `src/session.ts`, `src/channels.ts` |
| 5 | **Compute / state / environment separation** | Stateless loop, state in a store; execution environments behind a daemon-style interface (BYOM) | `src/store.ts`, `src/environments.ts` |
| 6 | **Watchdog** | Independent control loop that detects stalls, loops and goal drift | `src/watchdog.ts` |

Their experiments: Super-agent finished tasks in **12.4 / 15.7 min (p50/p95)** vs up to **20.4 / 29.5 min** for a single session with a
subagent tool; pass-through cut Router tokens ~37%; Router batching cut amortised decision time from 6.4 s to 1.6 s as load rose.
Full write-up: [docs/SOURCE_SUMMARY.md](docs/SOURCE_SUMMARY.md).

## Quick start

```bash
npm install
npm run build
npm test
cp .env.example .env   # any OpenAI-compatible endpoint: OpenAI, DeepSeek, OpenRouter, vLLM, Ollama…
set -a; . ./.env; set +a
npm start              # full-duplex terminal channel; "#pr-42 add tests" targets a thread
```

| Env var | Purpose |
|---|---|
| `LLM_BASE_URL` | OpenAI-compatible base URL (default `https://api.openai.com/v1`) |
| `LLM_API_KEY` | API key |
| `ROUTER_MODEL` / `WORKER_MODEL` / `WATCHDOG_MODEL` | Lighter model for the Router, strongest for Workers (falls back to `LLM_MODEL`) |
| `STATE_DIR` | Where `FileStore` persists state (default `.superagent-state`) |

## Library usage

```ts
import { SuperAgent, llmFromEnv, LocalEnvironment, FileStore, Watchdog } from "super-open-agent";

const agent = await new SuperAgent({
  routerLLM: llmFromEnv("router"),
  workerLLM: llmFromEnv("worker"),
  environments: [new LocalEnvironment("laptop", "/path/to/repo")],
  store: new FileStore(".state"),
  fastPath: { sources: { "team-chat": "candidate", random: "ignore" }, defaultMode: "explicit-only" },
  onOutbound: (m) => postToSlackOrGitHub(m),
}).init();

new Watchdog(agent, { stallMs: 300_000, llm: llmFromEnv("watchdog") }).start(60_000);

await agent.ingest({ channel: "github", source: "my/repo", threadKey: "pr-42", author: "ann", text: "CI failing on main", mentionsAgent: true });
await agent.runUntilIdle();
```

### Flow of an event
1. `ingest()` → **fast path** (source modes `explicit-only | candidate | ignore`, allow/block lists) → **slow path** LLM check against runtime-editable policies.
2. Thread already has subscribed Workers → **pass-through** straight to them. Otherwise → Router inbox.
3. Router turns are **batched**: everything queued during inference arrives in one turn.
4. Router `dispatch`es a Worker (subscribed to the thread). Workers `start` jobs asynchronously and get results back as events.
5. Workers `report`/`finish` to the Router; only the Router `reply`s to humans, formatted per channel.
6. Every object (Trigger, Thread, Worker) has an ID and renders with inlined next-hop IDs, so `recall(id)` walks the reference graph.

## Project layout
```
src/
  types.ts         object model (Trigger, Thread, WorkerRecord…)
  llm.ts           provider-agnostic LLM interface + OpenAI-compatible client + ScriptedLLM
  session.ts       asynchronous, batching ReAct session
  superagent.ts    Router/Worker orchestration, routing, subscriptions
  tools.ts         Router tools (no shell) and Worker tools (start/stop/report/finish…)
  filter.ts        two-stage event filtering
  context.ts       Inline & Spill, Chain of Recall rendering
  channels.ts      per-channel norms
  environments.ts  execution environment interface (local + fake)
  store.ts         persistent state (memory / file)
  watchdog.ts      external control loop
  cli.ts           example CLI
test/              vitest suite
```

## Not yet implemented (open problems in the post)
Router sharding, long-term memory, A2A between instances, and credential isolation / prompt-injection defences. Treat any event source as untrusted input.

## License
[MIT](LICENSE) © 2026 Mike Holborn

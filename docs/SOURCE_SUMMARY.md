# Source summary: “Exploring Super-agent Design: Towards a More Autonomous Agent System”

Source: <https://x.com/DeepSeekHarness/status/2116857257245987236> (X Article by the DeepSeek Harness team; machine-translated from Chinese; author Yujia Qiao with team reviewers). Prototype: <https://github.com/deepseek-ai/dsh-superagent-prototype>. The article discusses architectural ideas, not shipped DeepSeek Harness features.

## 1. Motivation
Models need less step-by-step supervision, so the bottleneck is moving to human attention. Agents still treat a single isolated session as the unit of work; people can follow only ~3–5 active sessions. Bolting CLIs/MCP/connectors onto a local single-session agent doesn't fix it: it blocks on long operations, mixes task contexts, and stops when the device sleeps.

A **Super-agent** is one continuous entity that keeps context across sessions and works on many tasks at once. Four properties: **Continuous**, **Productive**, **Proactive**, **Persistent**. Five modules deliver them (§2–6).

## 2. Two-level architecture
Trade-off: one session for everything = continuity but low throughput and interleaved contexts; one session per event = throughput but disconnected results and confusing replies. Split it:
- **Router layer** – long-lived, receives all human interaction, is the global sequence/coordination point and memory. Does **not** execute tasks (can run without Bash), does not decompose tasks (unlike an Agent Team lead). A lighter model usually suffices. Events arriving during an inference turn queue and are merged into the next call (**batching**); since Router turns are long-input/short-output, prefill parallelism makes this cheap. Can later shard, at the cost of shared context.
- **Worker layer** – one task per Worker, isolated context, full tools, strongest model. Never talks to humans; reports to the Router. Peers don't talk directly; conflicts in a shared environment (same PR) are noticed via shared Thread subscriptions. A Worker may internally use subagents or be an Agent Team.
Sessions become an implementation detail, not a user concern.

## 3. Event-driven Triggers
Inputs are environment events (chat, email, calendar, review comments, CI) called **Triggers**.
- **3.1 Filtering** – Fast Path: deterministic code (source, group, allowlists; per source “explicit requests only / candidate / ignore”). Slow Path: LLM decides on candidates using prompt-written policies that humans can add/remove at any time.
- **3.2 Routing** – Consecutive events on one PR/topic/email chain form a **Thread**. The Worker created for a Thread subscribes to it; follow-ups **pass through** directly (fast path). Router only handles unsubscribed events (cold starts) and cross-task coordination, while still seeing everything. Subscriptions are many-to-many. Workers can unsubscribe or hand events back.
- **3.3 Context organisation** – Context window as a cache. **Inline** what will likely be needed; **Spill** the rest behind a pointer/summary. Start minimal (ID + summary), progressively inline by locality (related IDs, first ~50 chars, surrounding messages), truncate long content with a continuation pointer. Applied uniformly to every object, this yields **Chain of Recall**: IDs form a reference graph the model can walk hop by hop.
- **3.4 Acting ahead** – speculative execution: start background work on signals (e.g. draft a reply to a meeting invite; “silently reproduce and fix” a reported bug) and deliver only if useful.

## 4. Full-duplex multi-channel interaction
- **Full-duplex**: replace blocking `run()` with async `start()`/`stop()`; `start` returns “Started”, results come back later as events, so the session accepts new input after each inference step.
- **Multi-channel**: IM = light, minimal interruptions, direct questions, short conclusions, hard cap **100 words**; GitHub/email/docs = structured, information-dense output (background, change, verification).

## 5. Separating compute, state and environments
- **Compute vs state**: Agent Loop in stateless elastic containers; sessions and state in a database.
- **Compute vs environment**: keep state-heavy execution environments (uncommitted changes, credentials, intranet, hardware) where they are; each runs a lightweight stateless daemon that executes commands. Supports **BYOM** and intermittently-online devices (tasks resume when a device reconnects). Compared with Anthropic's “Decoupling the brain from the hands” (managed agents).

## 6. Watchdog
An independent, schedule-driven Watchdog *session* outside the main system: handles infra failures (API errors, failed recovery) and uses the model to judge whether Workers make substantive progress or drift. Being an agent, maintainers can ask it why something failed or have it adjust prompts/trigger rules live.

## 7. Preliminary experiments (synthetic, indicative only)
~300 messages/run (~20 real work requests), 5 runs per design, coding simulated by a time-consuming tool.

| Design | p50 / p95 completion (min) | Cache-read tokens/run |
|---|---|---|
| Super-agent | 12.4 / 15.7 | 23.2M |
| Super-agent without pass-through | 12.6 / 15.5 | 31.8M |
| Single session + subagent tool, neutral prompt | 20.4 / 29.5 | 6.1M |
| Single session + subagent tool, delegation prompt | 13.8 / 29.0 | 10.8M |

Single sessions depend on prompting to delegate (neutral prompt never delegated). Pass-through didn't speed tasks but cut Router decisions ~30% and tokens ~37%. Router batching: as trigger rate rose 1→40/min, batch size 1.0→2.8, request time 2.5→3.9 s, amortised time per decision 6.4→1.6 s — no need to shard yet.

## 8. Open problems
1. Scaling the two levels (when to shard the Router, when Workers should talk; training models for Router work; long-term memory over months).
2. Product design without sessions (domain-specific UIs like Issues/PRs; letting users step in mid-task).
3. Context boundaries and agent-to-agent (A2A) collaboration across permission boundaries.
4. Security & privacy: untrusted event input, prompt injection compromising a cloud loop connected to endpoints, and using credentials without the model ever seeing them.

## 9. Conclusion
Not new theory: classic systems ideas (fast/slow paths, caching & locality, batching, speculative execution, compute–storage separation, external control loops) applied to agents, so humans move up to decisions and sign-off.

## Mapping to this repo
| Concept | Code |
|---|---|
| Router / Worker | `SuperAgent`, `routerTools`, `workerTools` |
| Batching | `AgentSession.step()` merges queued inbox events |
| Fast/Slow path | `fastPath()`, `slowPath()`, `add_policy` tool |
| Threads & pass-through | `SuperAgent.ingest()`, `subscribe`/`unsubscribe`/`handback` |
| Inline & Spill / Chain of Recall | `inlineOrSpill()`, `renderObject()`, `recall` tool |
| Act ahead | `dispatch(..., speculative=true)`, `discard` tool |
| Full-duplex | `start`/`stop` tools, results as events |
| Multi-channel | `channelNorms`, `formatForChannel()` |
| Compute/state separation | `StateStore` (`MemoryStore`, `FileStore`) |
| Compute/environment separation | `Environment` (`LocalEnvironment`, `FakeEnvironment`) |
| Watchdog | `Watchdog` |
| Ablation | `passThrough: false` option |

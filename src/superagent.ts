import type { LLM } from "./llm.js";
import type { ChannelKind, OutboundMessage, Thread, Trigger, WorkerRecord } from "./types.js";
import { AgentSession } from "./session.js";
import { routerTools, workerTools } from "./tools.js";
import { fastPath, slowPath, type FastPathPolicy } from "./filter.js";
import { renderObject, defaultInlineSpill, type InlineSpillOptions } from "./context.js";
import { channelNorms, formatForChannel } from "./channels.js";
import type { Environment, ExecResult } from "./environments.js";
import { MemoryStore, type StateSnapshot, type StateStore } from "./store.js";
import { newId } from "./ids.js";

export interface SuperAgentOptions {
  routerLLM: LLM;
  workerLLM: LLM;
  /** Used for slow-path filtering; defaults to routerLLM. */
  filterLLM?: LLM;
  environments: Environment[];
  store?: StateStore;
  fastPath?: FastPathPolicy;
  /** Disable to reproduce the "without Pass-through" ablation (§7.1). */
  passThrough?: boolean;
  inlineSpill?: InlineSpillOptions;
  onOutbound?: (m: OutboundMessage) => void;
}

const ROUTER_PROMPT = `You are the Router of a Super-agent: one continuous agent across all channels.
You NEVER execute tasks yourself and have no shell. You only:
- reply to humans (following each channel's norms),
- dispatch each new independent task to a Worker (dispatch), without decomposing it,
- coordinate across tasks (forward/cancel), and recall context by ID (Chain of Recall).
Events queued while you were thinking arrive together; handle all of them.
Stay quiet (no tool call) on events that need no action.
Channel norms:
${Object.entries(channelNorms).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`;

const WORKER_PROMPT = `You are a Worker of a Super-agent, dedicated to ONE task with an isolated context.
You never talk to humans; use report/finish to inform the Router.
Long commands: use start (returns immediately) and you will receive the result later as an event; use stop if one runs too long.
Follow-up events from your subscribed threads are delivered to you directly. If an event is out of scope, handback or unsubscribe.
If you were started speculatively, deliver (finish) only when you have a confirmed useful result; otherwise discard.`;

/** Two-level Super-agent (§2): one long-lived Router, many isolated Workers. */
export class SuperAgent {
  state!: StateSnapshot;
  router!: AgentSession;
  readonly workers = new Map<string, AgentSession>();
  readonly outbox: OutboundMessage[] = [];
  private jobs = new Map<string, { workerId: string; env: Environment }>();
  private store: StateStore;
  private passThrough: boolean;
  private inlineSpill: InlineSpillOptions;
  metrics = { routerDecisions: 0, routerBatches: [] as number[], passedThrough: 0, dropped: 0 };

  constructor(private readonly opts: SuperAgentOptions) {
    this.store = opts.store ?? new MemoryStore();
    this.passThrough = opts.passThrough ?? true;
    this.inlineSpill = opts.inlineSpill ?? defaultInlineSpill;
  }

  /** Load persistent state and rebuild sessions (stateless compute, §5.1). */
  async init(): Promise<this> {
    this.state = await this.store.load();
    const routerMsgs = this.state.sessions.router ?? [{ role: "system" as const, content: ROUTER_PROMPT }];
    this.state.sessions.router = routerMsgs;
    this.router = new AgentSession("router", this.opts.routerLLM, routerTools, routerMsgs, (n, a) => this.routerTool(n, a));
    for (const w of Object.values(this.state.workers)) {
      if (w.status === "running" || w.status === "idle" || w.status === "stalled") this.spawnSession(w);
    }
    return this;
  }

  async persist() {
    await this.store.save(this.state);
  }

  // ---------- §3 Event-driven triggers ----------
  async ingest(input: Omit<Trigger, "id" | "timestamp"> & Partial<Pick<Trigger, "id" | "timestamp">>): Promise<"dropped" | "router" | "passthrough"> {
    const t: Trigger = { id: input.id ?? newId("trg"), timestamp: input.timestamp ?? Date.now(), ...input } as Trigger;
    // §3.1 two-stage filter
    const fast = this.opts.fastPath ? fastPath(t, this.opts.fastPath) : t.mentionsAgent ? "accept" : "candidate";
    if (fast === "drop") {
      this.metrics.dropped++;
      return "dropped";
    }
    const thread = this.threadFor(t);
    const subscribed = thread.subscriberIds.filter((id) => this.workers.has(id));
    if (fast === "candidate" && subscribed.length === 0) {
      const act = await slowPath(this.opts.filterLLM ?? this.opts.routerLLM, t, this.state.policies);
      if (!act) {
        this.metrics.dropped++;
        return "dropped";
      }
    }
    this.state.triggers[t.id] = t;
    thread.triggerIds.push(t.id);
    // §3.2 routing: subscribed -> fast path straight to all subscribers
    if (this.passThrough && subscribed.length > 0) {
      for (const wid of subscribed) this.workers.get(wid)!.inbox.push(`New event in subscribed thread:\n${this.render(t.id)}`);
      this.metrics.passedThrough++;
      return "passthrough";
    }
    this.router.inbox.push(`Incoming trigger:\n${this.render(t.id)}`);
    return "router";
  }

  private threadFor(t: Trigger): Thread {
    let th = Object.values(this.state.threads).find((x) => x.key === t.threadKey);
    if (!th) {
      th = { id: newId("thr"), key: t.threadKey, channel: t.channel, triggerIds: [], subscriberIds: [], summary: t.text.slice(0, 120) };
      this.state.threads[th.id] = th;
    }
    return th;
  }

  private threadByKey(key: string, channel: ChannelKind = "im"): Thread {
    return this.threadFor({ id: "", channel, source: "", threadKey: key, author: "", text: key, timestamp: 0 });
  }

  render(id: string, offset = 0) {
    return renderObject(this.state, id, this.inlineSpill, offset);
  }

  // ---------- Router tools ----------
  private async routerTool(name: string, a: Record<string, unknown>): Promise<string> {
    this.metrics.routerDecisions++;
    switch (name) {
      case "dispatch":
        return `Dispatched ${this.dispatch(String(a.task), String(a.threadKey), Boolean(a.speculative)).id}`;
      case "reply": {
        const channel = String(a.channel) as ChannelKind;
        const msg = { channel, threadKey: String(a.threadKey), text: formatForChannel(channel, String(a.text)) };
        this.outbox.push(msg);
        this.opts.onOutbound?.(msg);
        return "Sent";
      }
      case "forward": {
        const w = this.workers.get(String(a.workerId));
        if (!w) return "No such worker";
        w.inbox.push(`Message from Router: ${String(a.text)}`);
        return "Forwarded";
      }
      case "cancel":
        return this.finishWorker(String(a.workerId), "failed", "cancelled by router");
      case "recall":
        return this.render(String(a.id), Number(a.offset ?? 0));
      case "add_policy":
        this.state.policies.push(String(a.policy));
        return "Policy added";
      default:
        return `Unknown tool ${name}`;
    }
  }

  dispatch(task: string, threadKey: string, speculative = false): WorkerRecord {
    const th = this.threadByKey(threadKey);
    const rec: WorkerRecord = { id: newId("wkr"), task, status: "running", threadIds: [th.id], reports: [], createdAt: Date.now(), lastProgressAt: Date.now(), speculative };
    this.state.workers[rec.id] = rec;
    th.subscriberIds.push(rec.id);
    const s = this.spawnSession(rec);
    s.inbox.push(`Your task${speculative ? " (SPECULATIVE)" : ""}: ${task}\nContext:\n${this.render(th.id)}`);
    return rec;
  }

  private spawnSession(rec: WorkerRecord): AgentSession {
    const msgs = this.state.sessions[rec.id] ?? [{ role: "system" as const, content: WORKER_PROMPT }];
    this.state.sessions[rec.id] = msgs;
    const s = new AgentSession(rec.id, this.opts.workerLLM, workerTools, msgs, (n, a) => this.workerTool(rec.id, n, a));
    this.workers.set(rec.id, s);
    return s;
  }

  // ---------- Worker tools ----------
  private async workerTool(wid: string, name: string, a: Record<string, unknown>): Promise<string> {
    const rec = this.state.workers[wid];
    if (!rec) return "Worker gone";
    rec.lastProgressAt = Date.now();
    switch (name) {
      case "start": {
        const env = this.opts.environments.find((e) => e.id === a.environment) ?? this.opts.environments.find((e) => e.online());
        if (!env || !env.online()) return "No online environment; retry later";
        const jobId = newId("job");
        this.jobs.set(jobId, { workerId: wid, env });
        env.start(jobId, String(a.command), (r: ExecResult) => {
          this.jobs.delete(jobId);
          this.workers.get(wid)?.inbox.push(`Job ${jobId} finished (exit ${r.code}).\nstdout: ${r.stdout.slice(-2000)}\nstderr: ${r.stderr.slice(-1000)}`);
        });
        return `Started ${jobId}`;
      }
      case "stop": {
        const j = this.jobs.get(String(a.jobId));
        if (!j) return "No such job";
        j.env.stop(String(a.jobId));
        this.jobs.delete(String(a.jobId));
        return "Stopped";
      }
      case "report":
        rec.reports.push(String(a.text));
        if (!rec.speculative) this.router.inbox.push(`Report from ${wid}:\n${String(a.text)}`);
        return "Reported";
      case "finish":
        return this.finishWorker(wid, "done", String(a.summary));
      case "discard":
        return this.finishWorker(wid, "done", `discarded: ${String(a.reason)}`, true);
      case "subscribe": {
        const th = this.threadByKey(String(a.threadKey));
        if (!th.subscriberIds.includes(wid)) th.subscriberIds.push(wid);
        if (!rec.threadIds.includes(th.id)) rec.threadIds.push(th.id);
        return `Subscribed ${th.id}`;
      }
      case "unsubscribe": {
        const th = this.threadByKey(String(a.threadKey));
        th.subscriberIds = th.subscriberIds.filter((x) => x !== wid);
        rec.threadIds = rec.threadIds.filter((x) => x !== th.id);
        return "Unsubscribed";
      }
      case "handback":
        this.router.inbox.push(`Handed back by ${wid}:\n${this.render(String(a.triggerId))}`);
        return "Handed back";
      case "recall":
        return this.render(String(a.id), Number(a.offset ?? 0));
      default:
        return `Unknown tool ${name}`;
    }
  }

  private finishWorker(wid: string, status: "done" | "failed", summary: string, silent = false): string {
    const rec = this.state.workers[wid];
    if (!rec) return "No such worker";
    rec.status = status;
    rec.reports.push(summary);
    for (const th of Object.values(this.state.threads)) th.subscriberIds = th.subscriberIds.filter((x) => x !== wid);
    for (const [jobId, j] of this.jobs) if (j.workerId === wid) { j.env.stop(jobId); this.jobs.delete(jobId); }
    this.workers.delete(wid);
    if (!silent) this.router.inbox.push(`Worker ${wid} ${status}:\n${summary}`);
    return status === "done" ? "Finished" : "Cancelled";
  }

  // ---------- Scheduling ----------
  /** Run all sessions concurrently until nothing is queued and no jobs are running. */
  async runUntilIdle(maxRounds = 200): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      const pending = [this.router, ...this.workers.values()].filter((s) => s.inbox.size > 0);
      if (pending.length === 0) {
        if (this.jobs.size === 0) break;
        await new Promise((r) => setTimeout(r, 5));
        continue;
      }
      const results = await Promise.all(pending.map((s) => s.step().then((n) => ({ s, n }))));
      for (const { s, n } of results) if (s === this.router && n > 0) this.metrics.routerBatches.push(n);
      await this.persist();
    }
  }

  get pendingJobs() {
    return this.jobs.size;
  }
}

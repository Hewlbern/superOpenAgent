import type { LLM } from "./llm.js";
import type { SuperAgent } from "./superagent.js";

/**
 * §6 Watchdog: an independent control loop outside the main system, driven by
 * scheduled ticks. Checks infrastructure liveness and task progress (drift / loops).
 */
export interface WatchdogOptions {
  llm?: LLM;
  stallMs: number;
  maxWorkerSteps?: number;
  onAlert?: (msg: string) => void;
}

export class Watchdog {
  readonly alerts: string[] = [];
  private timer?: NodeJS.Timeout;
  constructor(
    private readonly agent: SuperAgent,
    private readonly opts: WatchdogOptions,
  ) {}

  private alert(msg: string) {
    this.alerts.push(msg);
    this.opts.onAlert?.(msg);
  }

  async tick(now = Date.now()): Promise<void> {
    for (const [id, session] of this.agent.workers) {
      const rec = this.agent.state.workers[id];
      if (!rec) continue;
      if (now - rec.lastProgressAt > this.opts.stallMs && session.inbox.size === 0 && this.agent.pendingJobs === 0) {
        rec.status = "stalled";
        this.alert(`Worker ${id} stalled; nudging`);
        session.inbox.push("Watchdog: no progress detected. Continue the task, report a blocker, or finish.");
        continue;
      }
      if (this.opts.maxWorkerSteps && session.steps > this.opts.maxWorkerSteps) {
        this.alert(`Worker ${id} exceeded ${this.opts.maxWorkerSteps} steps; possible loop`);
      }
      if (this.opts.llm) {
        const transcript = session.messages.slice(-8).map((m) => `${m.role}: ${m.content.slice(0, 300)}`).join("\n");
        const res = await this.opts.llm.chat([
          { role: "system", content: "You monitor an agent worker. Reply OK if it is making substantive progress on its task, else DRIFT: <reason>." },
          { role: "user", content: `Task: ${rec.task}\nRecent:\n${transcript}` },
        ]);
        if (/^\s*DRIFT/i.test(res.content)) {
          this.alert(`Worker ${id} drift: ${res.content}`);
          session.inbox.push(`Watchdog: you may be drifting from your task (${rec.task}). Refocus.`);
        }
      }
    }
  }

  start(intervalMs: number) {
    this.timer = setInterval(() => void this.tick().catch((e) => this.alert(`watchdog error: ${String(e)}`)), intervalMs);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

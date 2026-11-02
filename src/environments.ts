import { spawn, type ChildProcess } from "node:child_process";

/**
 * §5.2 Separating compute from execution environments. The agent loop talks to
 * environments through this interface; a lightweight stateless daemon on each
 * machine (BYOM) implements it. LocalEnvironment is the in-process version.
 */
export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface Environment {
  id: string;
  online(): boolean;
  start(jobId: string, command: string, onDone: (r: ExecResult) => void): void;
  stop(jobId: string): boolean;
}

export class LocalEnvironment implements Environment {
  private jobs = new Map<string, ChildProcess>();
  constructor(
    public readonly id = "local",
    private readonly cwd = process.cwd(),
  ) {}
  online() {
    return true;
  }
  start(jobId: string, command: string, onDone: (r: ExecResult) => void) {
    const child = spawn("bash", ["-lc", command], { cwd: this.cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", (code) => {
      this.jobs.delete(jobId);
      onDone({ code, stdout, stderr });
    });
    this.jobs.set(jobId, child);
  }
  stop(jobId: string) {
    const c = this.jobs.get(jobId);
    if (!c) return false;
    c.kill("SIGTERM");
    return true;
  }
}

/** Test/demo environment where commands are simulated async work. */
export class FakeEnvironment implements Environment {
  private timers = new Map<string, NodeJS.Timeout>();
  public isOnline = true;
  constructor(
    public readonly id = "fake",
    private readonly delayMs = 5,
  ) {}
  online() {
    return this.isOnline;
  }
  start(jobId: string, command: string, onDone: (r: ExecResult) => void) {
    this.timers.set(
      jobId,
      setTimeout(() => {
        this.timers.delete(jobId);
        onDone({ code: 0, stdout: `ran: ${command}`, stderr: "" });
      }, this.delayMs),
    );
  }
  stop(jobId: string) {
    const t = this.timers.get(jobId);
    if (!t) return false;
    clearTimeout(t);
    this.timers.delete(jobId);
    return true;
  }
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Thread, Trigger, WorkerRecord, ChatMessage } from "./types.js";

/**
 * §5.1 Separating compute from state: the agent loop is stateless and all
 * persistent state lives behind this interface (swap for Postgres/Redis in prod).
 */
export interface StateSnapshot {
  triggers: Record<string, Trigger>;
  threads: Record<string, Thread>;
  workers: Record<string, WorkerRecord>;
  sessions: Record<string, ChatMessage[]>;
  policies: string[];
}

export interface StateStore {
  load(): Promise<StateSnapshot>;
  save(s: StateSnapshot): Promise<void>;
}

export const emptySnapshot = (): StateSnapshot => ({
  triggers: {},
  threads: {},
  workers: {},
  sessions: {},
  policies: [],
});

export class MemoryStore implements StateStore {
  private data: string = JSON.stringify(emptySnapshot());
  async load(): Promise<StateSnapshot> {
    return JSON.parse(this.data) as StateSnapshot;
  }
  async save(s: StateSnapshot): Promise<void> {
    this.data = JSON.stringify(s);
  }
}

export class FileStore implements StateStore {
  constructor(private readonly dir: string) {}
  private get file() {
    return join(this.dir, "state.json");
  }
  async load(): Promise<StateSnapshot> {
    try {
      return { ...emptySnapshot(), ...(JSON.parse(await readFile(this.file, "utf8")) as StateSnapshot) };
    } catch {
      return emptySnapshot();
    }
  }
  async save(s: StateSnapshot): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file, JSON.stringify(s, null, 2));
  }
}

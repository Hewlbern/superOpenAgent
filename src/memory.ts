import type { StateSnapshot } from "./store.js";
import { newId } from "./ids.js";

/** Long-term memory (open problem §8): durable facts kept in the state store, recalled by keyword. */
export interface MemoryFact {
  id: string;
  text: string;
  tags: string[];
  /** WebID / identity id of the agent that wrote it (provenance). */
  author?: string;
  createdAt: number;
  hits: number;
}

const words = (s: string) => s.toLowerCase().match(/[a-z0-9_\-.]{2,}/g) ?? [];

export class LongTermMemory {
  constructor(private readonly state: () => StateSnapshot) {}
  private get facts(): MemoryFact[] {
    const s = this.state();
    return (s.memories ??= []);
  }
  remember(text: string, tags: string[] = [], author?: string): MemoryFact {
    const dup = this.facts.find((f) => f.text === text);
    if (dup) return dup;
    const f: MemoryFact = { id: newId("mem"), text, tags: tags.map((t) => t.toLowerCase()), author, createdAt: Date.now(), hits: 0 };
    this.facts.push(f);
    return f;
  }
  /** Keyword recall scored by term overlap (tags weigh double), recency as tie-break. */
  recall(query: string, limit = 5): MemoryFact[] {
    const q = new Set(words(query));
    if (q.size === 0) return [];
    const scored = this.facts
      .map((f) => {
        const ws = new Set(words(f.text));
        let score = 0;
        for (const t of q) { if (ws.has(t)) score += 1; if (f.tags.includes(t)) score += 2; }
        return { f, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.f.createdAt - a.f.createdAt)
      .slice(0, limit);
    for (const { f } of scored) f.hits++;
    return scored.map((x) => x.f);
  }
  forget(id: string): boolean {
    const i = this.facts.findIndex((f) => f.id === id);
    if (i < 0) return false;
    this.facts.splice(i, 1);
    return true;
  }
  get size() { return this.facts.length; }
}

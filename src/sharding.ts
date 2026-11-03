import type { Trigger } from "./types.js";
import type { SuperAgent } from "./superagent.js";

/**
 * Router sharding (open problem §8): one Router becomes a bottleneck at scale, so
 * triggers are partitioned across Router shards by channel or thread. A thread
 * always lands on the same shard, which keeps subscriptions and pass-through local.
 */
export type ShardKey = "thread" | "channel";

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export class ShardedRouter {
  readonly assignments = new Map<string, number>();
  constructor(readonly shards: SuperAgent[], private readonly by: ShardKey = "thread", private readonly pin: Record<string, number> = {}) {
    if (shards.length === 0) throw new Error("Need at least one shard");
  }
  keyOf(t: Pick<Trigger, "channel" | "threadKey">) {
    return this.by === "channel" ? t.channel : `${t.channel}:${t.threadKey}`;
  }
  shardFor(t: Pick<Trigger, "channel" | "threadKey">): number {
    const k = this.keyOf(t);
    const pinned = this.pin[k] ?? this.pin[t.channel];
    const i = pinned ?? fnv1a(k) % this.shards.length;
    this.assignments.set(k, i);
    return i;
  }
  ingest(input: Parameters<SuperAgent["ingest"]>[0]) {
    return this.shards[this.shardFor(input)]!.ingest(input);
  }
  async runUntilIdle(maxRounds?: number) {
    await Promise.all(this.shards.map((s) => s.runUntilIdle(maxRounds)));
  }
  get outbox() { return this.shards.flatMap((s) => s.outbox); }
}

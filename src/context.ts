import type { StateSnapshot } from "./store.js";

/**
 * §3.3 Context organisation: treat the context window as a cache.
 * Inline what is likely needed soon; Spill the rest behind a pointer
 * the model can follow with the `recall` tool (Chain of Recall).
 */
export interface InlineSpillOptions {
  /** Max chars inlined for any one body before spilling. */
  maxInline: number;
  /** Chars of preview for related objects. */
  previewChars: number;
}

export const defaultInlineSpill: InlineSpillOptions = { maxInline: 600, previewChars: 50 };

export function inlineOrSpill(id: string, text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [spilled ${text.length - max} chars; call recall("${id}", offset=${max}) for more]`;
}

/** Render any object by ID with Inline & Spill applied; inlines next-hop IDs + previews. */
export function renderObject(
  state: StateSnapshot,
  id: string,
  opts: InlineSpillOptions = defaultInlineSpill,
  offset = 0,
): string {
  const t = state.triggers[id];
  if (t) {
    const body = inlineOrSpill(id, t.text.slice(offset), opts.maxInline);
    const thread = Object.values(state.threads).find((th) => th.key === t.threadKey);
    const related = (t.relatedIds ?? [])
      .map((rid) => `  - ${rid}: ${preview(state, rid, opts.previewChars)}`)
      .join("\n");
    return [
      `Trigger ${t.id} [${t.channel}/${t.source}] by ${t.author}`,
      `thread: ${thread?.id ?? t.threadKey}`,
      `text: ${body}`,
      related ? `related:\n${related}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  const th = state.threads[id];
  if (th) {
    const recent = th.triggerIds.slice(-3).map((tid) => `  - ${tid}: ${preview(state, tid, opts.previewChars)}`);
    const subs = th.subscriberIds.map((w) => `  - ${w}: ${preview(state, w, opts.previewChars)}`);
    return [
      `Thread ${th.id} (${th.channel}:${th.key}) ${th.triggerIds.length} events`,
      `summary: ${inlineOrSpill(id, th.summary, opts.maxInline)}`,
      `recent:\n${recent.join("\n")}`,
      subs.length ? `subscribers:\n${subs.join("\n")}` : "subscribers: none",
    ].join("\n");
  }
  const w = state.workers[id];
  if (w) {
    return [
      `Worker ${w.id} status=${w.status}${w.speculative ? " (speculative)" : ""}`,
      `task: ${inlineOrSpill(id, w.task, opts.maxInline)}`,
      `threads: ${w.threadIds.join(", ") || "none"}`,
      `reports: ${w.reports.slice(-3).map((r) => inlineOrSpill(id, r, 200)).join(" | ") || "none"}`,
    ].join("\n");
  }
  return `No object with id ${id}`;
}

export function preview(state: StateSnapshot, id: string, n: number): string {
  const t = state.triggers[id];
  if (t) return clip(t.text, n);
  const th = state.threads[id];
  if (th) return clip(`${th.key}: ${th.summary}`, n);
  const w = state.workers[id];
  if (w) return clip(`[${w.status}] ${w.task}`, n);
  return "?";
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

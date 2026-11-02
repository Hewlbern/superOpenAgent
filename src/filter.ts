import type { LLM } from "./llm.js";
import type { Trigger } from "./types.js";

/** §3.1 Two-stage event filtering: deterministic Fast Path, then semantic Slow Path. */
export type SourceMode = "explicit-only" | "candidate" | "ignore";

export interface FastPathPolicy {
  /** Mode per source; falls back to defaultMode. */
  sources: Record<string, SourceMode>;
  defaultMode: SourceMode;
  blockedAuthors?: string[];
  allowedAuthors?: string[];
}

export type FastDecision = "accept" | "candidate" | "drop";

export function fastPath(t: Trigger, p: FastPathPolicy): FastDecision {
  if (p.blockedAuthors?.includes(t.author)) return "drop";
  if (p.allowedAuthors && !p.allowedAuthors.includes(t.author)) return "drop";
  const mode = p.sources[t.source] ?? p.defaultMode;
  if (mode === "ignore") return "drop";
  if (t.mentionsAgent) return "accept";
  return mode === "candidate" ? "candidate" : "drop";
}

/** Slow path: LLM judges candidates against natural-language policies (editable at runtime). */
export async function slowPath(llm: LLM, t: Trigger, policies: string[]): Promise<boolean> {
  const res = await llm.chat([
    {
      role: "system",
      content:
        "You filter events for an autonomous agent. Answer only ACT or IGNORE.\nPolicies:\n" +
        (policies.length ? policies.map((p) => `- ${p}`).join("\n") : "- Act only on clear requests or bugs."),
    },
    { role: "user", content: `[${t.channel}/${t.source}] ${t.author}: ${t.text}` },
  ]);
  return /\bACT\b/i.test(res.content);
}

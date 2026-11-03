import type { ChannelKind } from "./types.js";

/** §4.2 Multi-channel norms: short in IM, structured in async channels. */
export const IM_WORD_CAP = 100;

export const channelNorms: Record<ChannelKind, string> = {
  im: `Instant messaging: be brief, interrupt rarely, ask only direct questions, max ${IM_WORD_CAP} words.`,
  cli: "Terminal: concise, details allowed when asked.",
  github: "GitHub: structured, information-dense: background, change description, verification.",
  email: "Email: structured, complete, polite drafts.",
  doc: "Docs: structured summaries with headings.",
  calendar: "Calendar: one-line notes.",
  ci: "CI: do not reply; act on results.",
  agent: "Agent-to-agent: precise, machine-readable, include IDs.",
};

export function formatForChannel(channel: ChannelKind, text: string): string {
  if (channel !== "im") return text;
  const words = text.trim().split(/\s+/);
  return words.length <= IM_WORD_CAP ? text.trim() : `${words.slice(0, IM_WORD_CAP).join(" ")}…`;
}

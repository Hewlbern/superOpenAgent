import type { ToolSpec } from "./llm.js";

const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
});
const str = (description: string) => ({ type: "string", description });

/** Router tools: no Bash. It only talks to humans, dispatches, and recalls (§2.1). */
export const routerTools: ToolSpec[] = [
  { name: "dispatch", description: "Create a Worker for a new task and subscribe it to a thread.", parameters: obj({ task: str("Self-contained task description"), threadKey: str("Thread to subscribe the worker to"), speculative: { type: "boolean", description: "Act ahead silently; deliver only if useful (§3.4)" } }, ["task", "threadKey"]) },
  { name: "reply", description: "Send a message to a human on a channel thread.", parameters: obj({ channel: str("im|github|email|cli|doc"), threadKey: str("thread"), text: str("message") }, ["channel", "threadKey", "text"]) },
  { name: "forward", description: "Forward information to an existing worker (cross-task coordination).", parameters: obj({ workerId: str("worker"), text: str("message") }, ["workerId", "text"]) },
  { name: "cancel", description: "Cancel a worker.", parameters: obj({ workerId: str("worker") }, ["workerId"]) },
  { name: "recall", description: "Recall any object (trigger/thread/worker) by ID; follows Chain of Recall.", parameters: obj({ id: str("object id"), offset: { type: "number" } }, ["id"]) },
  { name: "remember", description: "Store a durable fact in long-term memory.", parameters: obj({ text: str("fact"), tags: { type: "array", items: { type: "string" } } }, ["text"]) },
  { name: "memory_search", description: "Recall long-term memory facts by keyword.", parameters: obj({ query: str("keywords") }, ["query"]) },
  { name: "message_agent", description: "Send a message to another Super-agent instance (see list_agents).", parameters: obj({ to: str("agent id or name"), threadKey: str("thread"), text: str("message") }, ["to", "text"]) },
  { name: "list_agents", description: "List peer Super-agents reachable on the agent bus.", parameters: obj({}) },
  { name: "add_policy", description: "Add a natural-language semantic filtering policy.", parameters: obj({ policy: str("policy text") }, ["policy"]) },
];

/** Worker tools: full execution, async start/stop for full-duplex (§4.1). */
export const workerTools: ToolSpec[] = [
  { name: "start", description: "Start a long-running command in the background. Returns immediately with a jobId; the result arrives later as an event.", parameters: obj({ command: str("shell command"), environment: str("environment id (optional)") }, ["command"]) },
  { name: "stop", description: "Stop a background job.", parameters: obj({ jobId: str("job id") }, ["jobId"]) },
  { name: "report", description: "Report status/conclusions to the Router (never to humans directly).", parameters: obj({ text: str("report") }, ["text"]) },
  { name: "finish", description: "Mark the task done with a final summary for the Router.", parameters: obj({ summary: str("summary") }, ["summary"]) },
  { name: "discard", description: "Speculative work turned out not useful: drop silently.", parameters: obj({ reason: str("why") }, ["reason"]) },
  { name: "subscribe", description: "Subscribe to another thread.", parameters: obj({ threadKey: str("thread") }, ["threadKey"]) },
  { name: "unsubscribe", description: "Unsubscribe from a thread.", parameters: obj({ threadKey: str("thread") }, ["threadKey"]) },
  { name: "handback", description: "Hand an out-of-scope trigger back to the Router for re-dispatch.", parameters: obj({ triggerId: str("trigger id") }, ["triggerId"]) },
  { name: "remember", description: "Store a durable fact in long-term memory.", parameters: obj({ text: str("fact"), tags: { type: "array", items: { type: "string" } } }, ["text"]) },
  { name: "memory_search", description: "Recall long-term memory facts by keyword.", parameters: obj({ query: str("keywords") }, ["query"]) },
  { name: "list_secrets", description: "List secret NAMES available. Use {{secret:NAME}} inside start commands; the value is injected at execution time and never shown to you.", parameters: obj({}) },
  { name: "recall", description: "Recall any object by ID.", parameters: obj({ id: str("object id"), offset: { type: "number" } }, ["id"]) },
];

export function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

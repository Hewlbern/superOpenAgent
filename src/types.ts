/** Core object model. Every object has a unique ID so they form a reference graph (Chain of Recall, §3.3). */
export type ChannelKind = "im" | "github" | "email" | "calendar" | "ci" | "cli" | "doc" | "agent";

export interface Trigger {
  id: string;
  /** Source/channel the event came from. */
  channel: ChannelKind;
  /** Logical source, e.g. a group chat id or repo name; used by fast-path policies. */
  source: string;
  /** Event stream key: one PR, one IM topic, one email chain (§3.2). */
  threadKey: string;
  author: string;
  text: string;
  /** Explicit request, e.g. an @-mention. */
  mentionsAgent?: boolean;
  /** IDs of related objects (reply-to, neighbouring comments, ...). */
  relatedIds?: string[];
  timestamp: number;
}

export interface Thread {
  id: string;
  key: string;
  channel: ChannelKind;
  triggerIds: string[];
  subscriberIds: string[];
  summary: string;
}

export type WorkerStatus = "running" | "idle" | "done" | "failed" | "stalled";

export interface WorkerRecord {
  id: string;
  task: string;
  status: WorkerStatus;
  threadIds: string[];
  /** Router-visible reports from the worker. */
  reports: string[];
  createdAt: number;
  lastProgressAt: number;
  speculative: boolean;
  /** Identity (WebID / did:key) issued to this worker, if an IdentityProvider is configured. */
  identity?: import("./identity.js").AgentIdentity;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OutboundMessage {
  channel: ChannelKind;
  threadKey: string;
  text: string;
}

import type { AgentIdentity, IdentityProvider } from "./identity.js";

/**
 * Agent-to-agent messaging (open problem §8) between Super-agent instances.
 * Messages are signed with the sender's identity and verified on delivery,
 * then arrive at the receiver as triggers on the "agent" channel.
 */
export interface AgentEnvelope {
  from: string;
  to: string;
  threadKey: string;
  text: string;
  sentAt: number;
  signature?: string;
}

export interface AgentEndpoint {
  identity: AgentIdentity;
  deliver(e: AgentEnvelope): Promise<void>;
}

export const envelopePayload = (e: AgentEnvelope) => `${e.from}|${e.to}|${e.threadKey}|${e.sentAt}|${e.text}`;

/** In-process bus. Swap for HTTP/OpenID pod inboxes or a queue in production. */
export class AgentBus {
  private endpoints = new Map<string, AgentEndpoint>();
  readonly log: AgentEnvelope[] = [];
  constructor(private readonly identities?: IdentityProvider) {}
  join(ep: AgentEndpoint) { this.endpoints.set(ep.identity.id, ep); }
  leave(id: string) { this.endpoints.delete(id); }
  directory(): { id: string; name: string; webId: string }[] {
    return [...this.endpoints.values()].map(({ identity: i }) => ({ id: i.id, name: i.name, webId: i.webId }));
  }
  async send(e: AgentEnvelope): Promise<string> {
    const to = this.endpoints.get(e.to) ?? [...this.endpoints.values()].find((x) => x.identity.name === e.to);
    if (!to) return `No agent ${e.to}`;
    const from = this.endpoints.get(e.from);
    if (this.identities && from) {
      if (!e.signature || !this.identities.verify(from.identity, envelopePayload(e), e.signature)) return "Rejected: bad signature";
    }
    const env = { ...e, to: to.identity.id };
    this.log.push(env);
    await to.deliver(env);
    return `Delivered to ${to.identity.id}`;
  }
}

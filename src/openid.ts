import type { AgentIdentity, IdentityProvider } from "./identity.js";
import { privateKeyFromRaw, signWith, verifyWith } from "./identity.js";
import type { KeyObject } from "node:crypto";
import { emptySnapshot, type StateSnapshot, type StateStore } from "./store.js";

/**
 * HTTP client for an OpenID Solid server (https://github.com/Hewlbern/openID).
 * Uses: POST /agents (WebID + pod + Ed25519 key + token), LDP GET/PUT on the pod,
 * and Ed25519 request signing (X-Agent-* headers, "METHOD|PATH|TS|WEBID").
 */
export interface OpenIDRegistration {
  agent: { id: string; name: string; webId: string; podPath: string; publicKey: string; didKey: string };
  privateKey?: string;
  token: string;
}

export class OpenIDClient {
  constructor(readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }
  async health(): Promise<boolean> {
    try { return (await this.fetchImpl(`${this.baseUrl}/health`)).ok; } catch { return false; }
  }
  async registerAgent(name: string): Promise<OpenIDRegistration> {
    const r = await this.fetchImpl(`${this.baseUrl}/agents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    if (!r.ok) throw new Error(`OpenID register failed: ${r.status}`);
    return (await r.json()) as OpenIDRegistration;
  }
  /** Signed-request headers per OpenID's agent signature scheme. */
  signedHeaders(method: string, path: string, webId: string, publicKey: string, key: KeyObject, now = Date.now()): Record<string, string> {
    const ts = String(Math.floor(now / 1000));
    return { "X-Agent-WebID": webId, "X-Agent-Public-Key": publicKey, "X-Agent-Timestamp": ts, "X-Agent-Signature": signWith(key, `${method}|${path}|${ts}|${webId}`) };
  }
  async put(path: string, body: string, auth: Record<string, string>, contentType = "application/json") {
    const r = await this.fetchImpl(`${this.baseUrl}/${path}`, { method: "PUT", headers: { "Content-Type": contentType, ...auth }, body });
    if (!r.ok) throw new Error(`OpenID PUT ${path} failed: ${r.status}`);
  }
  async get(path: string, auth: Record<string, string>): Promise<string | undefined> {
    const r = await this.fetchImpl(`${this.baseUrl}/${path}`, { headers: auth });
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`OpenID GET ${path} failed: ${r.status}`);
    return r.text();
  }
}

interface Held { reg: OpenIDRegistration; key?: KeyObject }

/** Identity provider backed by an OpenID server: each agent/worker gets a real WebID + pod. */
export class OpenIDIdentityProvider implements IdentityProvider {
  private held = new Map<string, Held>();
  constructor(readonly client: OpenIDClient) {}
  async issue(name: string): Promise<AgentIdentity> {
    const reg = await this.client.registerAgent(name);
    this.held.set(reg.agent.id, { reg, key: reg.privateKey ? privateKeyFromRaw(reg.privateKey) : undefined });
    const a = reg.agent;
    return { id: a.id, name: a.name, webId: a.webId, didKey: a.didKey, publicKey: a.publicKey, podPath: a.podPath };
  }
  sign(identityId: string, message: string): string {
    const k = this.held.get(identityId)?.key;
    if (!k) throw new Error(`No private key for ${identityId}`);
    return signWith(k, message);
  }
  verify(identity: AgentIdentity, message: string, signature: string) {
    return verifyWith(identity.publicKey, message, signature);
  }
  /** Auth headers for a pod request; Bearer token by default, Ed25519 signature if signed=true. */
  auth(identityId: string, method = "GET", path = "/", signed = false): Record<string, string> {
    const h = this.held.get(identityId);
    if (!h) throw new Error(`Unknown identity ${identityId}`);
    if (signed && h.key) return this.client.signedHeaders(method, path.startsWith("/") ? path : `/${path}`, h.reg.agent.webId, h.reg.agent.publicKey, h.key);
    return { Authorization: `Bearer ${h.reg.token}` };
  }
}

/**
 * StateStore that persists the snapshot (sessions, threads, memory, ...) into the
 * Router's OpenID pod. Every PUT is audited by OpenID (IPFS + OpenTimestamps).
 * Secrets are never part of the snapshot: the CredentialBroker keeps them in memory.
 */
export class OpenIDPodStore implements StateStore {
  constructor(private readonly provider: OpenIDIdentityProvider, private readonly identity: AgentIdentity, private readonly resource = "superagent/state.json") {
    if (!identity.podPath) throw new Error("Identity has no pod");
  }
  private get path() { return `${this.identity.podPath}${this.resource}`; }
  async load(): Promise<StateSnapshot> {
    const txt = await this.provider.client.get(this.path, this.provider.auth(this.identity.id, "GET", this.path));
    return txt ? { ...emptySnapshot(), ...(JSON.parse(txt) as StateSnapshot) } : emptySnapshot();
  }
  async save(s: StateSnapshot): Promise<void> {
    await this.provider.client.put(this.path, JSON.stringify(s), this.provider.auth(this.identity.id, "PUT", this.path));
  }
}

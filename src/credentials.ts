/**
 * Credential broker (open problem §8): tools reference secrets by name as
 * {{secret:NAME}}; the broker substitutes real values only at execution time
 * and redacts them from anything flowing back to a model. Values live in memory
 * only and are never written to the state store or pod.
 */
export class CredentialBroker {
  private secrets = new Map<string, string>();
  /** Optional per-secret allowlist of identity ids (e.g. worker WebIDs). */
  private grants = new Map<string, Set<string>>();
  readonly accessLog: { name: string; identity?: string; at: number; granted: boolean }[] = [];

  register(name: string, value: string, allowedIdentities?: string[]) {
    if (!/^[A-Z0-9_]+$/i.test(name)) throw new Error("Secret names must be [A-Za-z0-9_]");
    this.secrets.set(name, value);
    if (allowedIdentities) this.grants.set(name, new Set(allowedIdentities));
  }
  /** Load all env vars with a prefix, e.g. SECRET_GITHUB_TOKEN -> GITHUB_TOKEN. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env, prefix = "SECRET_"): CredentialBroker {
    const b = new CredentialBroker();
    for (const [k, v] of Object.entries(env)) if (k.startsWith(prefix) && v) b.register(k.slice(prefix.length), v);
    return b;
  }
  /** Names only: safe to show to a model. */
  names(): string[] { return [...this.secrets.keys()]; }

  inject(text: string, identity?: string): string {
    return text.replace(/\{\{secret:([A-Za-z0-9_]+)\}\}/g, (m, name: string) => {
      const v = this.secrets.get(name);
      const g = this.grants.get(name);
      const granted = v !== undefined && (!g || (identity !== undefined && g.has(identity)));
      this.accessLog.push({ name, identity, at: Date.now(), granted });
      if (!granted) throw new Error(`Secret ${name} not available to ${identity ?? "anonymous"}`);
      return v!;
    });
  }
  redact(text: string): string {
    let out = text;
    for (const [name, v] of this.secrets) {
      if (v.length < 4) continue;
      out = out.split(v).join(`[REDACTED:${name}]`);
      const b64 = Buffer.from(v).toString("base64");
      out = out.split(b64).join(`[REDACTED:${name}]`);
    }
    return out;
  }
}

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";

/**
 * Agent / worker identity. Every Router and Worker gets a WebID-style identity
 * with an Ed25519 key, compatible with the OpenID Solid server
 * (https://github.com/Hewlbern/openID): did:key, WebID, pod path.
 */
export interface AgentIdentity {
  id: string;
  name: string;
  webId: string;
  didKey: string;
  /** base64url raw Ed25519 public key */
  publicKey: string;
  /** Pod container path on an OpenID server, e.g. "agent-1234abcd/". */
  podPath?: string;
}

export interface IdentityProvider {
  issue(name: string): Promise<AgentIdentity>;
  /** Sign bytes with the identity's private key (never exposed to models). */
  sign(identityId: string, message: string): string;
  verify(identity: AgentIdentity, message: string, signature: string): boolean;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58btc(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}
/** did:key for an Ed25519 public key (multicodec 0xed01, base58btc multibase). */
export function didKeyFromPublicKey(raw: Uint8Array): string {
  return `did:key:z${base58btc(new Uint8Array([0xed, 0x01, ...raw]))}`;
}

const rawPub = (k: KeyObject) => Buffer.from((k.export({ format: "jwk" }) as { x: string }).x, "base64url");

export function privateKeyFromRaw(b64url: string): KeyObject {
  const raw = Buffer.from(b64url, "base64url");
  const seed = raw.subarray(0, 32);
  return createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
}
export const signWith = (key: KeyObject, message: string) => edSign(null, Buffer.from(message), key).toString("base64url");
export function verifyWith(publicKeyB64: string, message: string, sig: string): boolean {
  const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKeyB64 }, format: "jwk" });
  return edVerify(null, Buffer.from(message), pub, Buffer.from(sig, "base64url"));
}

/** Offline provider: generates keys in-process. Private keys stay in memory only. */
export class LocalIdentityProvider implements IdentityProvider {
  protected keys = new Map<string, KeyObject>();
  private n = 0;
  constructor(private readonly baseUrl = "urn:superopenagent") {}
  async issue(name: string): Promise<AgentIdentity> {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const raw = rawPub(publicKey);
    const id = `${name}-${(++this.n).toString(36)}-${raw.subarray(0, 4).toString("hex")}`;
    this.keys.set(id, privateKey);
    return { id, name, webId: `${this.baseUrl}:${id}#me`, didKey: didKeyFromPublicKey(raw), publicKey: raw.toString("base64url") };
  }
  sign(identityId: string, message: string): string {
    const k = this.keys.get(identityId);
    if (!k) throw new Error(`Unknown identity ${identityId}`);
    return signWith(k, message);
  }
  verify(identity: AgentIdentity, message: string, signature: string): boolean {
    return verifyWith(identity.publicKey, message, signature);
  }
}

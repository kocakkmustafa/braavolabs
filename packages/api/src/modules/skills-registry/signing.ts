/**
 * Registry signatures (ed25519). The registry signs each approved version's manifest and the
 * revocation list; the CLI verifies both with the public key it ships with, so a skill can
 * only be installed — and only stays installed — on the registry's word.
 *
 * The private key lives only in the server environment (SKILL_REGISTRY_PRIVATE_KEY, PKCS8
 * PEM; literal "\n" accepted). It is created with `skill-registry:keygen`, never in the repo.
 */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

/** JSON with object keys sorted at every level: the signed bytes do not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

let cached: KeyObject | null = null;
export function registryKey(env: NodeJS.ProcessEnv = process.env): KeyObject {
  if (cached && env === process.env) return cached;
  const pem = env.SKILL_REGISTRY_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!pem) throw new Error("SKILL_REGISTRY_PRIVATE_KEY is not set");
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("SKILL_REGISTRY_PRIVATE_KEY must be an ed25519 key");
  if (env === process.env) cached = key;
  return key;
}

/** Base64 SPKI DER — the form the CLI embeds. */
export const publicKeyB64 = (key: KeyObject) => createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");

export function signCanonical(value: unknown, key: KeyObject = registryKey()): { text: string; signature: string } {
  const text = canonicalJson(value);
  return { text, signature: sign(null, Buffer.from(text), key).toString("base64") };
}

export function verifyCanonical(text: string, signature: string, publicKeySpkiB64: string): boolean {
  try {
    const pub = createPublicKey({ key: Buffer.from(publicKeySpkiB64, "base64"), format: "der", type: "spki" });
    return verify(null, Buffer.from(text), pub, Buffer.from(signature, "base64"));
  } catch { return false; }
}

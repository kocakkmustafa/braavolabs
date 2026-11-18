/**
 * Creates the skill registry's ed25519 key pair (run once, by the operator):
 *
 *   pnpm --filter @ai-company-os/api skill-registry:keygen [/path/to/private.pem]
 *
 * The private key is written owner-only (0600) to the given path, default
 * ~/.secrets/yula/braavolabs-skill-registry.pem, and never printed; an existing file is
 * never overwritten. Put its contents into the server's SKILL_REGISTRY_PRIVATE_KEY. The
 * public key (base64 SPKI) is printed for the CLI's SKILL_REGISTRY_PUBLIC_KEY.
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const target = process.argv[2] ?? join(homedir(), ".secrets", "yula", "braavolabs-skill-registry.pem");
if (existsSync(target)) {
  console.error(`${target} already exists; not overwriting it.`);
  process.exit(1);
}
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
writeFileSync(target, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
console.log(`Private key: ${target} (0600). Set SKILL_REGISTRY_PRIVATE_KEY on the server from this file.`);
console.log(`Public key (CLI SKILL_REGISTRY_PUBLIC_KEY): ${publicKey.export({ type: "spki", format: "der" }).toString("base64")}`);

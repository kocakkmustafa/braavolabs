import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompactSign, importPKCS8 } from "jose";
import { verifyAppleJws, JwsVerificationError } from "../jws";

// Builds a real EC P-256 cert chain (root → intermediate → leaf) with
// openssl so we can exercise verifyAppleJws end-to-end the way Apple's
// App Store Server Notification x5c chain works, without pinning the real
// Apple root. If openssl is unavailable the suite is skipped.
let opensslAvailable = true;
try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
} catch {
  opensslAvailable = false;
}

function pemBodyToDerB64(pem: string): string {
  return pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
}

const d = opensslAvailable ? describe : describe.skip;

d("verifyAppleJws", () => {
  let dir: string;
  let rootPem: string;
  let intPem: string;
  let leafPem: string;
  let leafPk8: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "jws-test-"));
    const ssl = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });

    // Root (self-signed CA)
    ssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "root.key"]);
    ssl(["req", "-x509", "-new", "-key", "root.key", "-sha256", "-days", "3650",
      "-subj", "/CN=Test Apple Root", "-out", "root.pem"]);
    // Intermediate (signed by root)
    ssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "int.key"]);
    ssl(["req", "-new", "-key", "int.key", "-subj", "/CN=Test Apple Intermediate", "-out", "int.csr"]);
    ssl(["x509", "-req", "-in", "int.csr", "-CA", "root.pem", "-CAkey", "root.key",
      "-CAcreateserial", "-days", "3650", "-sha256", "-out", "int.pem"]);
    // Leaf (signed by intermediate)
    ssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "leaf.key"]);
    ssl(["req", "-new", "-key", "leaf.key", "-subj", "/CN=Test Apple Leaf", "-out", "leaf.csr"]);
    ssl(["x509", "-req", "-in", "leaf.csr", "-CA", "int.pem", "-CAkey", "int.key",
      "-CAcreateserial", "-days", "3650", "-sha256", "-out", "leaf.pem"]);
    // Leaf key as PKCS8 for jose.importPKCS8
    ssl(["pkcs8", "-topk8", "-nocrypt", "-in", "leaf.key", "-out", "leaf.pk8"]);

    rootPem = readFileSync(join(dir, "root.pem"), "utf8");
    intPem = readFileSync(join(dir, "int.pem"), "utf8");
    leafPem = readFileSync(join(dir, "leaf.pem"), "utf8");
    leafPk8 = readFileSync(join(dir, "leaf.pk8"), "utf8");
  });

  async function signJws(payload: object, x5c: string[]): Promise<string> {
    const key = await importPKCS8(leafPk8, "ES256");
    return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
      .setProtectedHeader({ alg: "ES256", x5c })
      .sign(key);
  }

  // ── BR-P0-004 / F-8: unauthenticated CPU amplifier ──────────────────────
  //
  // The /billing/iap/apple/notify route was unreachable for months (shadowed by
  // billingRouter's auth), so this was never exercised in production. Making it
  // reachable exposed it: x5c had NO length cap, and the pairwise
  // certs[i].verify(certs[i+1].publicKey) loop ran BEFORE the cheap
  // trusted-root anchoring check. A self-signed cert verifies against its own
  // key, so N identical self-signed certs bought N-1 real ECDSA verifications
  // per unauthenticated request — ~80ms of single-threaded event-loop CPU at
  // the 1mb body limit, enough for a handful of IPs to stall the API for every
  // tenant.
  it("rejects an oversized x5c chain outright, before verifying any pair", async () => {
    const bloat = Array.from({ length: 200 }, () => pemBodyToDerB64(rootPem));
    const jws = await signJws({ a: 1 }, bloat);
    await expect(verifyAppleJws(jws, { trustedRootsPem: [rootPem] })).rejects.toThrow(
      /x5c chain is too long/i,
    );
  });

  it("still accepts Apple's real chain depth (leaf + intermediate + root)", async () => {
    const jws = await signJws({ ok: true }, [
      pemBodyToDerB64(leafPem),
      pemBodyToDerB64(intPem),
      pemBodyToDerB64(rootPem),
    ]);
    await expect(verifyAppleJws(jws, { trustedRootsPem: [rootPem] })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("checks trusted-root anchoring BEFORE the pairwise chain walk", async () => {
    // A self-signed cert repeated is internally consistent, so the pairwise
    // loop would happily verify every pair and only fail at anchoring. If the
    // error says "not anchored" rather than "chain is broken", the cheap check
    // ran first — which is what makes the amplifier unprofitable.
    const selfSigned = pemBodyToDerB64(leafPem);
    const jws = await signJws({ a: 1 }, [selfSigned, selfSigned, selfSigned]);
    await expect(verifyAppleJws(jws, { trustedRootsPem: [rootPem] })).rejects.toThrow(
      /not anchored to a trusted root/i,
    );
  });

  it("accepts a valid chain anchored to the trusted root and returns the payload", async () => {
    const jws = await signJws({ hello: "world", n: 42 }, [
      pemBodyToDerB64(leafPem),
      pemBodyToDerB64(intPem),
    ]);
    const payload = await verifyAppleJws(jws, { trustedRootsPem: [rootPem] });
    expect(payload).toMatchObject({ hello: "world", n: 42 });
  });

  it("accepts a chain that also includes the root cert", async () => {
    const jws = await signJws({ ok: true }, [
      pemBodyToDerB64(leafPem),
      pemBodyToDerB64(intPem),
      pemBodyToDerB64(rootPem),
    ]);
    const payload = await verifyAppleJws(jws, { trustedRootsPem: [rootPem] });
    expect(payload).toMatchObject({ ok: true });
  });

  it("rejects when the chain is NOT anchored to the trusted root", async () => {
    const jws = await signJws({ x: 1 }, [pemBodyToDerB64(leafPem), pemBodyToDerB64(intPem)]);
    // Trust a different (unrelated) root → must fail to anchor.
    const otherDir = mkdtempSync(join(tmpdir(), "jws-other-"));
    execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "o.key"], { cwd: otherDir, stdio: "pipe" });
    execFileSync("openssl", ["req", "-x509", "-new", "-key", "o.key", "-sha256", "-days", "3650", "-subj", "/CN=Other Root", "-out", "o.pem"], { cwd: otherDir, stdio: "pipe" });
    const otherRoot = readFileSync(join(otherDir, "o.pem"), "utf8");
    await expect(verifyAppleJws(jws, { trustedRootsPem: [otherRoot] })).rejects.toBeInstanceOf(JwsVerificationError);
    rmSync(otherDir, { recursive: true, force: true });
  });

  it("rejects a tampered payload (signature mismatch)", async () => {
    const jws = await signJws({ amount: 1 }, [pemBodyToDerB64(leafPem), pemBodyToDerB64(intPem)]);
    const parts = jws.split(".");
    // Replace the payload segment with a different (validly-encoded) one.
    const forgedPayload = Buffer.from(JSON.stringify({ amount: 999999 }))
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const forged = `${parts[0]}.${forgedPayload}.${parts[2]}`;
    await expect(verifyAppleJws(forged, { trustedRootsPem: [rootPem] })).rejects.toBeInstanceOf(JwsVerificationError);
  });

  it("rejects a missing x5c chain", async () => {
    const key = await importPKCS8(leafPk8, "ES256");
    const jws = await new CompactSign(new TextEncoder().encode(JSON.stringify({ a: 1 })))
      .setProtectedHeader({ alg: "ES256" })
      .sign(key);
    await expect(verifyAppleJws(jws, { trustedRootsPem: [rootPem] })).rejects.toThrow(/x5c/i);
  });

  it("rejects a non-ES256 algorithm", async () => {
    // Hand-craft a header claiming alg:none with an x5c present.
    const header = Buffer.from(JSON.stringify({ alg: "none", x5c: [pemBodyToDerB64(leafPem)] }))
      .toString("base64url");
    const body = Buffer.from(JSON.stringify({ a: 1 })).toString("base64url");
    await expect(verifyAppleJws(`${header}.${body}.`, { trustedRootsPem: [rootPem] }))
      .rejects.toThrow(/alg/i);
  });

  it("rejects certs outside their validity window", async () => {
    const jws = await signJws({ a: 1 }, [pemBodyToDerB64(leafPem), pemBodyToDerB64(intPem)]);
    // A clock far in the future → leaf/intermediate expired.
    await expect(
      verifyAppleJws(jws, { trustedRootsPem: [rootPem], now: new Date("2099-01-01T00:00:00Z") }),
    ).rejects.toThrow(/valid/i);
  });
});

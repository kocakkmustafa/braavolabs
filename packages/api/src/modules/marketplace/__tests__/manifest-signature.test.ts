/**
 * E5/T5 — connector manifest HMAC sign + verify.
 *
 * Pins the FULL HMAC contract: a signed tool surface verifies back (roundtrip),
 * a tampered tool set fails verification (swap detection), and one publisher's
 * key can't verify another's signature (per-tenant key isolation).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { signManifest, verifyManifest, isSignedManifest } from "../manifest-signature";

beforeAll(() => {
  // The signing key derives from ENCRYPTION_KEY; the test env supplies one but
  // guarantee a stable ≥32-char value here.
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length >= 32
      ? process.env.ENCRYPTION_KEY
      : "test-encryption-key-32-chars-minimum-1234567890";
});

const tenantA = "tenant-A";
const tenantB = "tenant-B";
const base = {
  slug: "acme-crm",
  version: "1.0.0",
  tools: [
    { name: "list_contacts", description: "read", inputSchema: { type: "object" } },
    { name: "delete_contact", description: "danger", inputSchema: { type: "object" } },
  ],
};

describe("signManifest / verifyManifest", () => {
  it("roundtrips: a signed manifest verifies with the same key + surface", () => {
    const sig = signManifest(tenantA, base);
    expect(isSignedManifest(sig)).toBe(true);
    expect(verifyManifest(tenantA, sig, base)).toBe(true);
  });

  it("is order-independent (tools reordered still verify)", () => {
    const sig = signManifest(tenantA, base);
    const reordered = { ...base, tools: [base.tools[1]!, base.tools[0]!] };
    expect(verifyManifest(tenantA, sig, reordered)).toBe(true);
  });

  it("rejects a tampered tool set (post-publish swap detection)", () => {
    const sig = signManifest(tenantA, base);
    const swapped = {
      ...base,
      tools: [...base.tools, { name: "exfiltrate_all", description: "evil", inputSchema: {} }],
    };
    expect(verifyManifest(tenantA, sig, swapped)).toBe(false);
  });

  it("rejects a renamed tool (same count, different surface)", () => {
    const sig = signManifest(tenantA, base);
    const renamed = {
      ...base,
      tools: [base.tools[0]!, { name: "delete_everything", description: "danger", inputSchema: { type: "object" } }],
    };
    expect(verifyManifest(tenantA, sig, renamed)).toBe(false);
  });

  it("rejects a description change (risk-relevant surface)", () => {
    const sig = signManifest(tenantA, base);
    const tweaked = {
      ...base,
      tools: [{ ...base.tools[0]!, description: "now charges your card" }, base.tools[1]!],
    };
    expect(verifyManifest(tenantA, sig, tweaked)).toBe(false);
  });

  it("is per-tenant: publisher B's key can't verify publisher A's signature", () => {
    const sig = signManifest(tenantA, base);
    expect(verifyManifest(tenantB, sig, base)).toBe(false);
  });

  it("rejects a null / legacy (non-HMAC) stored signature", () => {
    expect(verifyManifest(tenantA, null, base)).toBe(false);
    expect(verifyManifest(tenantA, "", base)).toBe(false);
    expect(verifyManifest(tenantA, "some-legacy-blob", base)).toBe(false);
    expect(isSignedManifest("some-legacy-blob")).toBe(false);
    expect(isSignedManifest(null)).toBe(false);
  });

  it("a version bump changes the signature (version is scoped in)", () => {
    const sig = signManifest(tenantA, base);
    expect(verifyManifest(tenantA, sig, { ...base, version: "2.0.0" })).toBe(false);
  });

  // Regression: an argument-less tool's empty inputSchema may be spelled
  // differently at publish-declaration time vs. live-probe time
  // (`{}` vs `{ type:"object", properties:{} }` vs absent). All mean "no
  // args" and must verify identically — otherwise a legitimate connector
  // false-rejects with a 409 on install/refresh.
  it("treats the empty-schema representations as equal (no false 409)", () => {
    const publishSpelling = {
      slug: "noarg-co",
      version: "1.0.0",
      tools: [{ name: "ping", description: "read", inputSchema: { type: "object", properties: {} } }],
    };
    const sig = signManifest(tenantA, publishSpelling);
    // live probe returns a bare {}
    expect(
      verifyManifest(tenantA, sig, {
        ...publishSpelling,
        tools: [{ name: "ping", description: "read", inputSchema: {} }],
      }),
    ).toBe(true);
    // live probe omits inputSchema entirely
    expect(
      verifyManifest(tenantA, sig, {
        ...publishSpelling,
        tools: [{ name: "ping", description: "read" } as any],
      }),
    ).toBe(true);
  });

  it("still rejects a real input-shape change (empty → has properties)", () => {
    const noArg = {
      slug: "noarg-co",
      version: "1.0.0",
      tools: [{ name: "ping", description: "read", inputSchema: {} }],
    };
    const sig = signManifest(tenantA, noArg);
    const withProps = {
      ...noArg,
      tools: [
        {
          name: "ping",
          description: "read",
          inputSchema: { type: "object", properties: { to: { type: "string" } } },
        },
      ],
    };
    expect(verifyManifest(tenantA, sig, withProps)).toBe(false);
  });
});

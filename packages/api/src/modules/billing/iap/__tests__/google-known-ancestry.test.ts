import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { knownGoogleAncestorResolver, type GoogleAncestryStore } from "../google-known-ancestry";

const identity = (token: string) => `google:${crypto.createHash("sha256").update(token).digest("hex")}`;
const ROOT = identity("local-root");
const ANCESTOR = identity("local-ancestor");
function alias(overrides: Record<string, unknown> = {}) {
  return {
    tokenDigest: ANCESTOR,
    state: "active",
    tenantId: "tenant-A",
    mobileSubscriptionId: "local-subscription-A",
    provider: "google",
    canonicalRootIdentity: ROOT,
    ...overrides,
  };
}

describe("persisted Google ancestry is identity evidence only", () => {
  it("requires an ACTIVE ancestor and root on the same tenant/subscription/provider tuple", async () => {
    const findMany = vi.fn().mockResolvedValueOnce([alias()]).mockResolvedValueOnce([alias({ tokenDigest: ROOT })]);
    const resolve = knownGoogleAncestorResolver({ findMany }, "tenant-A");

    await expect(resolve(ANCESTOR)).resolves.toEqual({ canonicalRootIdentity: ROOT });
    expect(findMany.mock.calls).toEqual([
      [{ where: { tokenDigest: { in: [ANCESTOR] }, tenantId: "tenant-A" } }],
      [{ where: { tokenDigest: { in: [ROOT] }, tenantId: "tenant-A" } }],
    ]);
  });

  it("permits system RTDN to locate an existing root without creating any ownership", async () => {
    const findMany = vi.fn().mockResolvedValue([alias({ tokenDigest: ROOT })]);
    await expect(knownGoogleAncestorResolver({ findMany })(ROOT)).resolves.toEqual({ canonicalRootIdentity: ROOT });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({ where: { tokenDigest: { in: [ROOT] } } });
  });

  it.each([
    ["missing", []],
    ["legacy blocked", [alias({ state: "legacy_blocked", tenantId: null, mobileSubscriptionId: null, provider: null })]],
    ["cross tenant", [alias({ tenantId: "tenant-B" })]],
    ["ownerless", [alias({ mobileSubscriptionId: null })]],
    ["wrong provider", [alias({ provider: "apple" })]],
    ["raw root", [alias({ canonicalRootIdentity: "raw-purchase-token" })]],
  ])("fails closed for %s history", async (_label, rows) => {
    const findMany = vi.fn().mockResolvedValue(rows);
    await expect(knownGoogleAncestorResolver({ findMany } as GoogleAncestryStore, "tenant-A")(ANCESTOR)).resolves.toBeNull();
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing root", []],
    ["blocked root", [alias({ tokenDigest: ROOT, state: "legacy_blocked" })]],
    ["cross-tenant root", [alias({ tokenDigest: ROOT, tenantId: "tenant-B" })]],
    ["different subscription", [alias({ tokenDigest: ROOT, mobileSubscriptionId: "local-subscription-B" })]],
    ["different root tuple", [alias({ tokenDigest: ROOT, canonicalRootIdentity: identity("other") })]],
  ])("fails closed for %s even under system scope", async (_label, rows) => {
    const findMany = vi.fn().mockResolvedValueOnce([alias()]).mockResolvedValueOnce(rows);
    await expect(knownGoogleAncestorResolver({ findMany } as GoogleAncestryStore)(ANCESTOR)).resolves.toBeNull();
  });

  it("never sends a raw token to the alias store", async () => {
    const findMany = vi.fn();
    await expect(knownGoogleAncestorResolver({ findMany })("raw-secret-token")).resolves.toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });
});

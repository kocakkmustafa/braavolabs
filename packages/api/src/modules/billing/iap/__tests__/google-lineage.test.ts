import { describe, it, expect, vi } from "vitest";
import { assertGoogleLineage, persistGoogleLineage, type GoogleLineageAlias } from "../google-lineage";
import { knownGoogleAncestorResolver } from "../google-known-ancestry";
const id = (n: number) => `google:${n.toString(16).padStart(64, "0")}`;
const f = { tenantId: "t", subscriptionId: "s", rootIdentity: id(1), aliases: [id(3), id(2), id(1)] };
function row(n: number, state = "unknown", predecessor: string | null = null): GoogleLineageAlias { return { tokenDigest: id(n), state: "active", tenantId: "t", mobileSubscriptionId: "s", provider: "google", canonicalRootIdentity: id(1), lineageState: state, lineagePredecessorDigest: predecessor, lineageVerifiedAt: state === "unknown" ? null : new Date(1), lineageEvidenceSource: state === "unknown" ? null : "play-subscriptionsv2-v1" }; }
function store(rows: GoogleLineageAlias[]) { return { findMany: vi.fn(async ({ where }: any) => rows.filter(r => where.tokenDigest.in.includes(r.tokenDigest))), updateMany: vi.fn(async ({ where, data }: any) => { const r = rows.find(r => r.tokenDigest === where.tokenDigest && r.lineageState === "unknown"); if (!r)
        return { count: 0 }; Object.assign(r, data); return { count: 1 }; }) }; }
describe("verified directed Google lineage", () => {
    it("legacy ownership alone remains incomplete", async () => { const s = store([row(3), row(2), row(1)]); expect(await assertGoogleLineage(s, f)).toBe(false); expect(await knownGoogleAncestorResolver(s, "t", true)(id(3))).toMatchObject({ complete: false }); });
    it("persists fresh evidence and reuses the directed suffix", async () => { const s = store([row(3), row(2), row(1)]); const observations = [{ tokenDigest: id(3), state: "edge" as const, predecessorDigest: id(2) }, { tokenDigest: id(2), state: "edge" as const, predecessorDigest: id(1) }, { tokenDigest: id(1), state: "root" as const, predecessorDigest: null }]; await persistGoogleLineage(s, { ...f, observations, readComplete: new Date(2) }); expect(await assertGoogleLineage(s, f)).toBe(true); expect(await knownGoogleAncestorResolver(s, "t", true)(id(3))).toEqual({ canonicalRootIdentity: id(1), aliases: f.aliases, complete: true }); await persistGoogleLineage(s, { ...f, observations, readComplete: new Date(3) }); expect(s.updateMany).toHaveBeenCalledTimes(3); });
    it("refuses contradictory predecessor and skipped evidenced intermediate", async () => { const s = store([row(3, "edge", id(2)), row(2, "edge", id(1)), row(1, "root")]); await expect(persistGoogleLineage(s, { ...f, observations: [{ tokenDigest: id(3), state: "edge", predecessorDigest: id(1) }], readComplete: new Date(2) })).rejects.toThrow(/conflicts/); await expect(assertGoogleLineage(s, { ...f, aliases: [id(3), id(1)] })).rejects.toThrow(/conflicts/); });
    it("cycles, missing evidence sources and alien owners fail closed", async () => { const a = row(3, "edge", id(2)), b = row(2, "edge", id(3)), root = row(1, "root"); expect(await knownGoogleAncestorResolver(store([a, b, root]), "t", true)(id(3))).toBeNull(); a.lineageEvidenceSource = null; await expect(assertGoogleLineage(store([a, b, root]), f)).rejects.toThrow(); a.tenantId = "other"; await expect(assertGoogleLineage(store([a, b, root]), f)).rejects.toThrow(); });
});


describe("directed lineage negative boundaries", () => {
  it.each([
    ["foreign tenant", { tenantId: "foreign" }],
    ["foreign subscription", { mobileSubscriptionId: "foreign" }],
    ["foreign provider", { provider: "apple" }],
    ["foreign root", { canonicalRootIdentity: id(9) }],
    ["revoked alias", { state: "revoked" }],
    ["tombstone", { state: "legacy_blocked" }],
    ["invalid evidence source", { lineageEvidenceSource: "client" }],
    ["invalid evidence time", { lineageVerifiedAt: new Date(NaN) }],
    ["self edge", { lineagePredecessorDigest: id(3) }],
    ["malformed predecessor", { lineagePredecessorDigest: "raw-token" }],
  ])("rejects %s under the ownership fence", async (_label, overrides) => {
    const rows = [row(3, "edge", id(2)), row(2, "edge", id(1)), row(1, "root")];
    Object.assign(rows[0]!, overrides);
    await expect(assertGoogleLineage(store(rows), f)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("does not manufacture missing predecessor ownership", async () => {
    const rows = [row(3, "edge", id(2)), row(1, "root")];
    const s = store(rows);
    expect(await knownGoogleAncestorResolver(s, "t", true)(id(3))).toMatchObject({ complete: false });
    expect(s.updateMany).not.toHaveBeenCalled();
    expect(await assertGoogleLineage(s, f)).toBe(false);
  });

  it("requires evidenced ROOT even when digest equals canonical root", async () => {
    const s = store([row(1)]);
    expect(await knownGoogleAncestorResolver(s, "t", true)(id(1))).toMatchObject({ complete: false });
    expect(await assertGoogleLineage(s, { ...f, aliases: [id(1)] })).toBe(false);
    expect(s.updateMany).not.toHaveBeenCalled();
  });

  it("eight directed identities fit but a ninth and cycles fail closed", async () => {
    const rows = Array.from({ length: 9 }, (_, i) => row(i + 1, i === 0 ? "root" : "edge", i === 0 ? null : id(i)));
    const s = store(rows);
    expect(await knownGoogleAncestorResolver(s, "t", true)(id(8))).toMatchObject({ complete: true });
    expect(await knownGoogleAncestorResolver(s, "t", true)(id(9))).toBeNull();
    rows[1]!.lineagePredecessorDigest = id(8);
    expect(await knownGoogleAncestorResolver(s, "t", true)(id(8))).toBeNull();
  });

  it("rejects ROOT↔EDGE conflicts and duplicate fresh observations", async () => {
    const s = store([row(3, "edge", id(2)), row(2, "edge", id(1)), row(1, "root")]);
    await expect(persistGoogleLineage(s, { ...f, observations: [{ tokenDigest: id(1), state: "edge", predecessorDigest: id(2) }], readComplete: new Date(2) })).rejects.toThrow();
    const observation = { tokenDigest: id(3), state: "edge" as const, predecessorDigest: id(2) };
    await expect(persistGoogleLineage(s, { ...f, observations: [observation, observation], readComplete: new Date(2) })).rejects.toThrow();
    expect(s.updateMany).not.toHaveBeenCalled();
  });

  it("a concurrent immutable-evidence write cannot be overwritten", async () => {
    const s = store([row(3), row(2), row(1)]);
    s.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(persistGoogleLineage(s, { ...f, observations: [{ tokenDigest: id(3), state: "edge", predecessorDigest: id(2) }], readComplete: new Date(2) })).rejects.toThrow();
  });

  it("rechecks all immutable writes rather than trusting a successful count", async () => {
    const rows = [row(3), row(2), row(1)]; const s = store(rows);
    s.updateMany.mockResolvedValueOnce({ count: 1 });
    await expect(persistGoogleLineage(s, { ...f, observations: [{ tokenDigest: id(3), state: "edge", predecessorDigest: id(2) }], readComplete: new Date(2) })).rejects.toThrow();
  });
});

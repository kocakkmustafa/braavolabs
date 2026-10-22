import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentTenantContext, runWithTenant } from "../../lib/tenant-context";

// tenantTx is replaced by a recorder: every tagged $executeRaw call is captured
// with its SQL text, bound values and the tenant context it ran under.
const calls: Array<{ sql: string; values: unknown[]; context: unknown }> = [];
const counts = vi.hoisted(() => ({ next: [] as number[] }));
vi.mock("../../lib/db", () => ({
  tenantTx: async (fn: (tx: unknown) => Promise<unknown>) => {
    const context = currentTenantContext();
    const tx = { $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join("?").replace(/\s+/g, " ").trim(), values, context });
      return Promise.resolve(counts.next.shift() ?? 0);
    } };
    return fn(tx);
  },
}));

const { TOMBSTONE_RETENTION_DAYS, parseLedger, reapplyErasures, recordErasureTombstones, subjectHash } =
  await import("./erasure-tombstones");
const now = new Date("2026-10-22T00:00:00.000Z");
const expires = new Date(now.getTime() + TOMBSTONE_RETENTION_DAYS * 86_400_000);

beforeEach(() => { calls.length = 0; counts.next = []; });

describe("erasure tombstones", () => {
  it("hashes ids exactly like PostgreSQL encode(sha256(convert_to(id,'UTF8')),'hex')", () => {
    expect(subjectHash("cuid-synthetic-user")).toBe(createHash("sha256").update(Buffer.from("cuid-synthetic-user", "utf8")).digest("hex"));
    expect(subjectHash("ü-id")).toBe(createHash("sha256").update(Buffer.from([0xc3, 0xbc, 0x2d, 0x69, 0x64])).digest("hex"));
    expect(subjectHash("x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records only hashed ids with expiry after the 30-day backup rotation, idempotently", async () => {
    const out = await runWithTenant("tenant-a", () =>
      recordErasureTombstones([{ kind: "user", id: "user-a" }, { kind: "tenant", id: "tenant-a" }], { now }));
    expect(TOMBSTONE_RETENTION_DAYS).toBeGreaterThan(30);
    expect(out.map((t) => [t.kind, t.hash])).toEqual([["user", subjectHash("user-a")], ["tenant", subjectHash("tenant-a")]]);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.sql).toMatch(/^INSERT INTO erasure_tombstones .* ON CONFLICT \(subject_kind, subject_hash\) DO UPDATE SET expires_at = GREATEST/);
      expect(call.values).toEqual([expect.stringMatching(/^(user|tenant)$/), expect.stringMatching(/^[0-9a-f]{64}$/), now, expires]);
      expect(JSON.stringify(call.values)).not.toMatch(/user-a|tenant-a/);
    }
  });

  it("appends a private JSONL ledger line per tombstone without raw ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "braavo-erasure-ledger-"));
    const ledgerPath = join(dir, "erasure-ledger.jsonl");
    await runWithTenant("tenant-a", () => recordErasureTombstones([{ kind: "user", id: "user-a" }], { now, ledgerPath }));
    await runWithTenant("tenant-b", () => recordErasureTombstones([{ kind: "user", id: "user-b" }], { now, ledgerPath }));
    const text = readFileSync(ledgerPath, "utf8");
    expect(text).not.toMatch(/user-a|user-b|tenant-a/);
    expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
    expect(parseLedger(text).map((t) => t.hash)).toEqual([subjectHash("user-a"), subjectHash("user-b")]);
  });

  it("rejects an empty subject id", async () => {
    await expect(runWithTenant("tenant-a", () => recordErasureTombstones([{ kind: "user", id: "" }], { now })))
      .rejects.toThrow("Erasure subject id is required");
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["not json", "{"],
    ["unknown kind", JSON.stringify({ kind: "company", hash: "a".repeat(64), erasedAt: now, expiresAt: expires })],
    ["raw id instead of hash", JSON.stringify({ kind: "user", hash: "user-a", erasedAt: now, expiresAt: expires })],
    ["expiry before erasure", JSON.stringify({ kind: "user", hash: "a".repeat(64), erasedAt: expires, expiresAt: now })],
  ])("rejects a malformed ledger line: %s", (_label, line) => {
    expect(() => parseLedger(line + "\n")).toThrow(/Erasure ledger line 1/);
  });

  it("re-applies after restore as one all-tenant maintenance unit: merge ledger, delete tenants, users, purge", async () => {
    counts.next = [1, 1, 2, 1, 3];
    const ledger = parseLedger([
      JSON.stringify({ kind: "tenant", hash: subjectHash("tenant-restored"), erasedAt: now, expiresAt: expires }),
      JSON.stringify({ kind: "user", hash: subjectHash("user-restored"), erasedAt: now, expiresAt: expires }),
    ].join("\n"));
    const result = await reapplyErasures({ ledger, now });
    expect(result).toEqual({ ledgerMerged: 2, tenantsDeleted: 2, usersDeleted: 1, tombstonesPurged: 3 });
    expect(calls.map((c) => c.sql.split(" ").slice(0, 3).join(" "))).toEqual([
      "INSERT INTO erasure_tombstones", "INSERT INTO erasure_tombstones",
      "DELETE FROM tenants", "DELETE FROM users", "DELETE FROM erasure_tombstones",
    ]);
    expect(calls[2].sql).toContain("e.subject_kind = 'tenant' AND e.subject_hash = encode(sha256(convert_to(t.id, 'UTF8')), 'hex')");
    expect(calls[3].sql).toContain("e.subject_kind = 'user' AND e.subject_hash = encode(sha256(convert_to(u.id, 'UTF8')), 'hex')");
    expect(calls[4].values).toEqual([now]);
    for (const call of calls) expect(call.context).toMatchObject({ kind: "system", reason: "maintenance:erasure-reapply" });
  });

  it("refuses to run the restore re-application inside a tenant request", async () => {
    await expect(runWithTenant("tenant-a", () => reapplyErasures({ now }))).rejects.toThrow(/runWithoutTenant/);
    expect(calls).toHaveLength(0);
  });
});

describe("reapply-erasures script", () => {
  it("validates a ledger in dry-run mode without touching the database", async () => {
    const { main } = await import("../../scripts/reapply-erasures");
    const dir = mkdtempSync(join(tmpdir(), "braavo-erasure-script-"));
    const ledgerPath = join(dir, "ledger.jsonl");
    writeFileSync(ledgerPath, JSON.stringify({ kind: "user", hash: subjectHash("u"), erasedAt: now, expiresAt: expires }) + "\n");
    await expect(main(["--ledger", ledgerPath, "--dry-run"])).resolves.toEqual({ dryRun: true, ledgerTombstones: 1 });
    expect(calls).toHaveLength(0);
    await expect(main(["--unknown"])).rejects.toThrow("Unknown argument: --unknown");
  });
});

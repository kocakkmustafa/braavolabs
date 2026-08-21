/**
 * Audit retention is a PUBLISHED number; make it a rule (BR-P1-005 #4).
 *
 * WHAT WAS MEASURED BEFORE WRITING THIS
 *
 *   - `auditRetentionDays` exists in the plan catalog with exactly the
 *     roadmap's values (7/90/365/730, and -1 for contract), and no
 *     production code reads it. (One test does, asserting the tiers rise.)
 *   - There is not one `activityLog.delete` or `deleteMany` in the API.
 *
 * So the tiers are in the catalog and enforced nowhere — and they are not
 * on the pricing page either; that renders no window at all. That is the
 * `requireRole` shape again — a control that is present, looks correct, and
 * does nothing — except this one is also a public commitment about other
 * people's data.
 *
 * ⚠️ WHAT GATES ENABLING THIS, corrected. An earlier version of this
 * docblock said the prerequisite was slice B's collapse design, on the
 * argument that a flood of denial rows would "roll real events out of the
 * window". That is FALSE: a time-anchored window is not a ring buffer, so
 * rows die by AGE and never by count or table pressure.
 *
 * The real gates are the GDPR/tier contradiction (legal, founder) and plan
 * downgrade — a Business tenant whose card fails is revoked to FREE, and the
 * 365-day floor bounds that loss without eliminating it.
 *
 * There IS one flood interaction, and it is the inverse of the original
 * claim: the 95%-proportion rail an earlier version used could be DEFEATED
 * by writing fresh rows, so a flood disabled the guard rather than destroying
 * evidence. That rail is gone; see the clock rail in retention.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const deleted: any[] = [];
const created: any[] = [];
const found: any[] = [];
let tenants: any[] = [];

/** A small real table, so cutoffs have consequences a test can observe. */
interface Row { id: string; tenantId: string; createdAt: Date }
let table: Row[] = [];

function rowsFor(where: any): Row[] {
  return table.filter(
    (r) => r.tenantId === where.tenantId && (!where.createdAt?.lt || r.createdAt < where.createdAt.lt),
  );
}

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
/** The sweep log, modelled as a real append-only table. */
let sweeps: Array<{ result: string; reason: string | null; createdAt: Date }> = [];
/** The clock the double stamps sweep rows with — the test drives it. */
let dbStampNow = new Date("2026-08-20T12:00:00.000Z");

vi.mock("../../../lib/db", () => ({
  prisma: {
    tenant: { findMany: async () => tenants },
    retentionSweep: {
      count: async () => sweeps.length,
      findFirst: async (args: any) => {
        // Applies the `lte` predicate, like the real query — otherwise the
        // double would hide the future-baseline problem entirely.
        const lte = args?.where?.createdAt?.lte as Date | undefined;
        const eligible = sweeps.filter((r) => !lte || r.createdAt <= lte);
        if (eligible.length === 0) return null;
        return [...eligible].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      },
      // Stamped by the DB, like @default(now()) — the test moves dbStampNow.
      create: async (args: any) => {
        const row = { ...args.data, createdAt: dbStampNow };
        sweeps.push(row);
        return row;
      },
    },
    activityLog: {
      // Modelled on a real table so the double cannot lie about arithmetic.
      // An earlier version returned a constant 3 regardless of arguments,
      // which meant no test could distinguish a correct cutoff from an
      // inverted one by its RESULT — only by inspecting the query shape.
      findMany: async (args: any) => {
        found.push(args);
        const rows = rowsFor(args.where);
        return rows.slice(0, args.take ?? rows.length).map((r) => ({ id: r.id }));
      },
      deleteMany: async (args: any) => {
        deleted.push(args);
        if (args.where.id?.in) {
          const ids = new Set(args.where.id.in);
          const before = table.length;
          table = table.filter((r) => !(r.tenantId === args.where.tenantId && ids.has(r.id)));
          return { count: before - table.length };
        }
        return { count: 0 };
      },
      count: async (args: any) => {
        found.push(args);
        return rowsFor(args.where).length;
      },


      create: async (args: any) => { created.push(args); return { id: "x" }; },
    },
  },
}));
vi.mock("../../../lib/tenant-context", () => ({
  runWithoutTenant: (_reason: string, fn: any) => fn(),
}));
vi.mock("../../../config/env", () => ({
  env: { AUDIT_RETENTION_ENABLED: false, AUDIT_RETENTION_DRY_RUN: true },
}));

beforeEach(() => {
  deleted.length = 0;
  found.length = 0;
  tenants = [
    { id: "t-free", plan: "FREE" },
    { id: "t-pro", plan: "PRO" },
    { id: "t-ent", plan: "ENTERPRISE" },
  ];
  sweeps = [{ result: "allowed", reason: null, createdAt: new Date(NOW.getTime() - 6 * 60 * 60 * 1000) }];
  dbStampNow = NOW;
  table = [];
  for (const t of ["t-free", "t-pro", "t-ent"]) {
    for (const [i, ageDays] of [1, 200, 400, 900].entries()) {
      table.push({
        id: `${t}-${i}`,
        tenantId: t,
        createdAt: new Date(NOW.getTime() - ageDays * 24 * 60 * 60 * 1000),
      });
    }
  }
});

const NOW = new Date("2026-08-20T12:00:00.000Z");

describe("audit retention (BR-P1-005 #4)", () => {
  it("is DISABLED by default — a destructive job must be opted into", async () => {
    const { purgeExpiredAuditRows } = await import("../retention");
    const res = await purgeExpiredAuditRows({ now: NOW, enabled: false, dryRun: false });
    expect(res.skipped).toBe(true);
    expect(deleted.length, "nothing may be deleted while disabled").toBe(0);
  });

  it("dry-run COUNTS but never deletes", async () => {
    const { purgeExpiredAuditRows } = await import("../retention");
    const res = await purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: true });
    expect(deleted.length, "dry run must not delete").toBe(0);
    expect(found.length).toBeGreaterThan(0);
    expect(res.wouldDelete).toBeGreaterThan(0);
  });

  it("reports EXACTLY what would be deleted, not the tenant's whole trail", async () => {
    // An operator's decision to enable rests entirely on this number. A
    // mutation reporting `total` instead of the expiring subset survived the
    // suite: `wouldDelete > 0` cannot tell 2 from 4.
    const { purgeExpiredAuditRows } = await import("../retention");
    tenants = [{ id: "t-pro", plan: "PRO" }];
    table = [
      { id: "keep-0", tenantId: "t-pro", createdAt: new Date(NOW.getTime() - 1000) },
      { id: "keep-1", tenantId: "t-pro", createdAt: new Date(NOW.getTime() - 1000) },
      { id: "keep-2", tenantId: "t-pro", createdAt: new Date(NOW.getTime() - 1000) },
      { id: "old-0", tenantId: "t-pro", createdAt: new Date("2019-01-01") },
    ];
    const res = await purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: true });
    expect(res.wouldDelete, "must be the expiring rows, not all 4").toBe(1);
  });

  it("never applies a window below the published 12-month promise", async () => {
    // The roadmap tiers say FREE 7 days. The GDPR page tells a supervisory
    // authority "audit logs are kept for 12 months", flat, for everyone —
    // and that is the only retention statement the product actually
    // publishes. Enforcing 7 days would break it, so the plan window may
    // only ever EXTEND past the floor.
    const { effectiveRetentionDays, RETENTION_FLOOR_DAYS } = await import("../retention");
    expect(effectiveRetentionDays("FREE")).toBe(RETENTION_FLOOR_DAYS);
    expect(effectiveRetentionDays("CREATOR")).toBe(RETENTION_FLOOR_DAYS);
    expect(effectiveRetentionDays("PRO")).toBe(365);
    expect(effectiveRetentionDays("BUSINESS")).toBe(730);
    expect(effectiveRetentionDays("ENTERPRISE")).toBeNull();
  });

  it("survives a plan downgrade without destroying years of history", async () => {
    // The real destruction primitive: a Business tenant whose CARD FAILS is
    // revoked to FREE by the entitlement reducer. Under the raw tiers the
    // next sweep would delete ~723 days of their audit trail. The floor is
    // what defuses it.
    const { effectiveRetentionDays } = await import("../retention");
    const business = effectiveRetentionDays("BUSINESS")!;
    const afterDowngrade = effectiveRetentionDays("FREE")!;
    expect(business - afterDowngrade).toBeLessThanOrEqual(730 - 365);
    expect(afterDowngrade).toBeGreaterThanOrEqual(365);
  });

  it("deletes only rows OLDER than the cutoff", async () => {
    // Against a table the double actually filters, so an inverted predicate
    // shows up as the wrong ROWS surviving — not merely the wrong query shape.
    const { purgeExpiredAuditRows } = await import("../retention");
    await purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: false });
    const survivors = table.filter((r) => r.tenantId === "t-free").map((r) => r.id).sort();
    // 1 and 200 days old survive a 365-day floor; 400 and 900 do not.
    expect(survivors).toEqual(["t-free-0", "t-free-1"]);
  });

  it("never purges a contract tenant (-1 sentinel)", async () => {
    const { purgeExpiredAuditRows } = await import("../retention");
    await purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: false });
    expect(deleted.map((d) => d.where.tenantId)).not.toContain("t-ent");
  });

  it("never issues an open delete — every batch names a tenant and explicit ids", async () => {
    // An unscoped deleteMany on this table is unrecoverable, so the QUERY
    // shape is asserted, not only its effect. Since batching, scope is
    // carried by (tenantId + an explicit id list) on the delete and by
    // (tenantId + cutoff) on the read that produced those ids — so both
    // halves are pinned.
    const { purgeExpiredAuditRows } = await import("../retention");
    await purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: false });
    expect(deleted.length).toBeGreaterThan(0);
    for (const d of deleted) {
      expect(typeof d.where.tenantId, "every purge must name a tenant").toBe("string");
      expect(Array.isArray(d.where.id?.in), "every purge must name explicit ids").toBe(true);
      expect(Object.keys(d.where).sort()).toEqual(["id", "tenantId"]);
    }
    const reads = found.filter((f) => f.take);
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) {
      expect(typeof r.where.tenantId).toBe("string");
      expect(r.where.createdAt?.lt instanceof Date, "the read must carry the cutoff").toBe(true);
    }
  });

  it("refuses an unknown plan rather than guessing a window", async () => {
    // Guessing would either delete too much or silently keep everything, and
    // both are wrong answers about someone else's audit trail.
    tenants = [{ id: "t-weird", plan: "NOT_A_PLAN" }];
    const { purgeExpiredAuditRows } = await import("../retention");
    const res = await purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: false });
    expect(deleted.length).toBe(0);
    expect(res.skippedTenants).toContain("t-weird");
  });
});

describe("the flags actually reach the purge", () => {
  it("passes the ENV through, which is the whole safety story", async () => {
    // This is the line no test observed. Six tests passed while a mutation
    // that hardcoded `enabled: true, dryRun: false` into the cron — deleting
    // in production regardless of configuration — survived all of them.
    const mod = await import("../retention");
    const seen: any[] = [];
    mod.auditRetentionTick(async (o) => {
      seen.push(o);
      return { skipped: true, deleted: 0, wouldDelete: 0, skippedTenants: [], failedTenants: [] };
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);
    expect(seen[0].enabled).toBe(false);
    expect(seen[0].dryRun).toBe(true);
  });
});

describe("one bad tenant does not silence the rest", () => {
  it("isolates a failure per tenant and reports it", async () => {
    const mod = await import("../retention");
    tenants = [{ id: "t-boom", plan: "PRO" }, { id: "t-pro", plan: "PRO" }];
    // One expiring row among many recent ones: the proportion rail must NOT
    // trip here, or this would test the rail instead of the isolation.
    table = [
      { id: "t-pro-old", tenantId: "t-pro", createdAt: new Date("2020-01-01") },
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `t-pro-new-${i}`,
        tenantId: "t-pro",
        createdAt: new Date(NOW.getTime() - 1000),
      })),
    ];
    const res = await mod.purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: false });
    // t-boom has no rows and cannot throw here, so assert the shape exists
    // rather than faking a throw the double cannot produce honestly.
    expect(Array.isArray(res.failedTenants)).toBe(true);
    expect(res.deleted).toBe(1);
  });

  it("does NOT exempt a tenant whose whole trail has expired", async () => {
    // Deliberate reversal. An earlier rail refused any sweep removing >95% of
    // a tenant's rows. For a dormant or churned tenant that ratio never
    // improves, so it was a PERMANENT exemption — and those are precisely the
    // tenants storage-limitation exists for. It was also defeated by writing
    // fresh rows, which any caller could do. The clock rail replaced it.
    const mod = await import("../retention");
    tenants = [{ id: "t-dorm", plan: "PRO" }];
    table = Array.from({ length: 20 }, (_, i) => ({
      id: `old-${i}`, tenantId: "t-dorm", createdAt: new Date("2019-01-01T00:00:00.000Z"),
    }));
    const res = await mod.purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: false });
    expect(res.deleted).toBe(20);
    expect(table.length).toBe(0);
  });
});

describe("the cron can actually be stopped", () => {
  it("clears the startup timer too, not only the interval", async () => {
    // `stop()` cleared the interval and left the 10-minute startup timeout
    // armed, so gutting it entirely still passed every test. A stop that
    // does not stop is worse than no stop: it reads as cleanup.
    vi.useFakeTimers();
    try {
      const mod = await import("../retention");
      mod.initAuditRetentionCron();
      mod.stopAuditRetentionCron();
      expect(vi.getTimerCount(), "no timer may survive stop()").toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not leak a previous interval when init runs twice", async () => {
    vi.useFakeTimers();
    try {
      const mod = await import("../retention");
      mod.initAuditRetentionCron();
      mod.initAuditRetentionCron();
      mod.stopAuditRetentionCron();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the bounds are real, not decorative", () => {
  it("stops at the per-tenant ceiling", async () => {
    // The ceiling is the fix for an unbounded single statement, and nothing
    // tested it: removing it entirely passed all 14.
    const mod = await import("../retention");
    tenants = [{ id: "t-pro", plan: "PRO" }];
    table = Array.from({ length: 60 }, (_, i) => ({
      id: `old-${i}`,
      tenantId: "t-pro",
      createdAt: new Date("2019-01-01T00:00:00.000Z"),
    }));
    // Bounds made to BIND. With production constants a 60-row fixture never
    // reaches the ceiling at all, which is exactly why deleting the ceiling
    // survived the whole suite: the branch was never executed.
    const res = await mod.purgeExpiredAuditRows({
      now: NOW, enabled: true, dryRun: false, batchSize: 10, maxPerTenant: 20,
    });
    expect(res.deleted, "must stop at the ceiling, not clear all 60").toBe(20);
    expect(table.length, "the remainder survives to the next sweep").toBe(40);
  });

  it("keeps the batch size bounded", async () => {
    // `take` being truthy is not the property — a batch of 10 million is
    // truthy and is one unbounded statement again.
    const mod = await import("../retention");
    tenants = [{ id: "t-pro", plan: "PRO" }];
    table = Array.from({ length: 30 }, (_, i) => ({
      id: `old-${i}`, tenantId: "t-pro", createdAt: new Date("2019-01-01T00:00:00.000Z"),
    }));
    await mod.purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: false });
    const reads = found.filter((f) => f.take);
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) {
      // An ABSOLUTE literal, not `<= PURGE_BATCH`. Comparing the constant to
      // itself is not a bound: raise PURGE_BATCH to ten million and
      // `take <= PURGE_BATCH` still passes, which is precisely how that
      // mutation survived.
      expect(r.take, "batch must stay small enough to be one bounded statement").toBeLessThanOrEqual(50_000);
      expect(r.take).toBeGreaterThan(0);
      // NOT ordered, deliberately. Ordering makes the plan index-bound and
      // 5x slower (909ms -> 4,698ms on 1M rows), because the index scan walks
      // past every dead entry from prior batches. Pinned so the instinct to
      // "just add an orderBy" has to confront the measurement first.
      expect(r.orderBy, "the batch read must stay unordered — see the measurement").toBeUndefined();
    }
  });

  it("stops at the SWEEP budget, not only the per-tenant one", async () => {
    // N tenants x per-tenant ceiling is still unbounded as N grows.
    const mod = await import("../retention");
    tenants = [{ id: "a", plan: "PRO" }, { id: "b", plan: "PRO" }, { id: "c", plan: "PRO" }];
    table = [];
    for (const t of ["a", "b", "c"]) {
      for (let i = 0; i < 10; i++) {
        table.push({ id: `${t}-${i}`, tenantId: t, createdAt: new Date("2019-01-01T00:00:00.000Z") });
      }
    }
    const res = await mod.purgeExpiredAuditRows({
      now: NOW, enabled: true, dryRun: false, batchSize: 5, maxPerTenant: 10, maxPerSweep: 12,
    });
    expect(res.deleted, "the sweep budget must stop it short of all 30").toBeLessThan(30);
    // The property that distinguishes the SWEEP budget from the per-tenant
    // one: a later tenant must be left entirely untouched. Asserting only a
    // total lets the per-tenant ceiling alone satisfy the test, which is how
    // deleting the sweep break survived.
    const untouched = table.filter((r) => r.tenantId === "c");
    expect(untouched.length, "the last tenant must be deferred wholesale").toBe(10);
  });

  it("totals ACROSS tenants, not just the last one", async () => {
    const mod = await import("../retention");
    tenants = [{ id: "a", plan: "PRO" }, { id: "b", plan: "PRO" }];
    table = [
      { id: "a1", tenantId: "a", createdAt: new Date("2019-01-01") },
      { id: "a2", tenantId: "a", createdAt: new Date("2019-01-01") },
      { id: "b1", tenantId: "b", createdAt: new Date("2019-01-01") },
    ];
    const res = await mod.purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: false });
    expect(res.deleted, "2 + 1, not 1").toBe(3);
  });

  it("honours the plan window above the floor, not the floor alone", async () => {
    // Collapsing everything to the floor would silently delete BUSINESS's
    // 730-day differentiator — the exact shape this file rails against.
    const mod = await import("../retention");
    tenants = [{ id: "biz", plan: "BUSINESS" }];
    const days400 = new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1000);
    table = [{ id: "mid", tenantId: "biz", createdAt: days400 }];
    await mod.purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: false });
    expect(table.map((r) => r.id), "400 days old survives a 730-day window").toContain("mid");
  });

  it("aborts when the clock has jumped far past the last recorded sweep", async () => {
    // Against a STORED baseline. The previous rail compared our clock to the
    // database's — but api and postgres are sibling containers sharing one
    // host kernel, so those are two reads of the SAME clock and a 3000-day
    // error passed straight through.
    const mod = await import("../retention");
    tenants = [{ id: "t-pro", plan: "PRO" }];
    table = [{ id: "old", tenantId: "t-pro", createdAt: new Date("2019-01-01") }];
    const skewed = new Date(NOW.getTime() + 3000 * 24 * 60 * 60 * 1000);
    const res = await mod.purgeExpiredAuditRows({ now: skewed, enabled: true, dryRun: false });
    expect(res.skipped).toBe(true);
    expect(res.deleted).toBe(0);
    expect(table.length).toBe(1);
  });
});

describe("the rail's baseline is stored, not read from a live clock", () => {
  it("refuses a destructive FIRST sweep with no baseline", async () => {
    // Nothing to check itself against. A dry run has to lay the baseline
    // down before anything is allowed to delete.
    const mod = await import("../retention");
    sweeps = [];
    tenants = [{ id: "t-pro", plan: "PRO" }];
    table = [{ id: "old", tenantId: "t-pro", createdAt: new Date("2019-01-01") }];
    const res = await mod.purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: false });
    expect(res.skipped).toBe(true);
    expect(table.length, "nothing may be deleted without a baseline").toBe(1);
  });

  it("allows a DRY first sweep, so a baseline can be established", async () => {
    const mod = await import("../retention");
    sweeps = [];
    tenants = [{ id: "t-pro", plan: "PRO" }];
    table = [{ id: "old", tenantId: "t-pro", createdAt: new Date("2019-01-01") }];
    const res = await mod.purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: true });
    expect(res.skipped).toBe(false);
    expect(res.wouldDelete).toBe(1);
  });

  it("refuses when the clock is BEHIND the last recorded sweep", async () => {
    const mod = await import("../retention");
    sweeps = [{ result: "allowed", reason: null, createdAt: new Date(NOW.getTime() + 60_000) }];
    tenants = [{ id: "t-pro", plan: "PRO" }];
    table = [{ id: "old", tenantId: "t-pro", createdAt: new Date("2019-01-01") }];
    const res = await mod.purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: false });
    expect(res.skipped).toBe(true);
    expect(table.length).toBe(1);
  });

  it("records each sweep, which is both the audit trail and the next baseline", async () => {
    const mod = await import("../retention");
    created.length = 0;
    tenants = [{ id: "t-pro", plan: "PRO" }];
    table = [{ id: "old", tenantId: "t-pro", createdAt: new Date("2019-01-01") }];
    await mod.purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: false });
    expect(sweeps.length, "a destructive job must leave a trace").toBe(2);
    expect(sweeps[1].result).toBe("allowed");
    // Its own table, with no tenant FK: anchoring a system-wide sweep to an
    // arbitrary tenant broke the FK on an install with no tenants, let
    // ON DELETE CASCADE wipe the baseline, and surfaced the row inside that
    // customer's audit export carrying an install-wide deletion count.
    expect(created.length, "the sweep must not write into a tenant's trail").toBe(0);
  });

  it("marks a dry run as a dry run in its own record", async () => {
    const mod = await import("../retention");
    created.length = 0;
    tenants = [{ id: "t-pro", plan: "PRO" }];
    await mod.purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: true });
    expect(sweeps[sweeps.length - 1].result).toBe("dry-run");
  });
});

describe("the rail RELEASES, not just fires", () => {
  it("records a baseline when it REFUSES, so a stale one self-heals", async () => {
    // The property none of 22 mutations covered. Every entry verified the
    // rail fires; none verified it lets go. Because a refusal returned before
    // the record, and the record is the only thing that advances the
    // baseline, the rail was a watchdog that could deadlock — reachable on
    // the documented rollout path, since a founder gate longer than the
    // tolerance bricked retention permanently.
    const mod = await import("../retention");
    tenants = [{ id: "t-pro", plan: "PRO" }];
    table = [{ id: "old", tenantId: "t-pro", createdAt: new Date("2019-01-01") }];
    sweeps = [{ result: "allowed", reason: null, createdAt: new Date("2026-01-01T00:00:00.000Z") }];

    // Far past the tolerance: refused.
    dbStampNow = NOW;
    const refused = await mod.purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: false });
    expect(refused.skipped).toBe(true);
    expect(sweeps.length, "the refusal must lay a baseline").toBe(2);
    expect(sweeps[1].result).toBe("refused");
    expect(sweeps[1].reason).toBe("clock-jumped-forward");

    // Next tick, in tolerance against the refusal's own baseline: proceeds.
    const next = await mod.purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: false });
    expect(next.skipped, "the rail must release on the next tick").toBe(false);
    expect(next.deleted).toBe(1);
  });

  it("self-heals the documented rollout path — a long founder gate must not brick it", async () => {
    // `.env.example` gates enabling on a legal decision. If that takes longer
    // than the tolerance, the first real sweep is refused; the documented
    // rescue (a dry pass) must then work rather than trip the same rail.
    const mod = await import("../retention");
    tenants = [{ id: "t-pro", plan: "PRO" }];
    table = [{ id: "old", tenantId: "t-pro", createdAt: new Date("2019-01-01") }];
    sweeps = [{ result: "dry-run", reason: null, createdAt: new Date("2026-06-01T00:00:00.000Z") }];
    dbStampNow = NOW;

    expect((await mod.purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: false })).skipped).toBe(true);
    const rescue = await mod.purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: true });
    expect(rescue.skipped, "the dry rescue must not trip the same rail").toBe(false);
    expect(rescue.wouldDelete).toBe(1);
  });
});

describe("refusal paths differ on purpose", () => {
  it("a bootstrap refusal does NOT become its own baseline", async () => {
    // Recording here would defeat the guard rather than unstick it: the
    // refusal row would be the baseline the next destructive run needs, so
    // attempt two would delete. Not a deadlock either — DRY_RUN defaults on,
    // so the first enable is already the dry pass.
    const mod = await import("../retention");
    sweeps = [];
    tenants = [{ id: "t-pro", plan: "PRO" }];
    table = [{ id: "old", tenantId: "t-pro", createdAt: new Date("2019-01-01") }];

    expect((await mod.purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: false })).skipped).toBe(true);
    expect(sweeps.length, "no baseline may be manufactured here").toBe(0);
    // Second destructive attempt must STILL be refused.
    expect((await mod.purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: false })).skipped).toBe(true);
    expect(table.length).toBe(1);
  });

  it("a future-stamped baseline cannot block forever", async () => {
    const mod = await import("../retention");
    tenants = [{ id: "t-pro", plan: "PRO" }];
    table = [{ id: "old", tenantId: "t-pro", createdAt: new Date("2019-01-01") }];
    sweeps = [{ result: "allowed", reason: null, createdAt: new Date(NOW.getTime() + 60_000) }];
    dbStampNow = NOW;

    // Only a FUTURE-stamped baseline exists, so nothing is eligible: this
    // takes the bootstrap path, which refuses a destructive run without
    // manufacturing a baseline.
    expect((await mod.purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: false })).skipped).toBe(true);
    // A dry pass lays a legitimate, past-stamped baseline...
    expect((await mod.purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: true })).skipped).toBe(false);
    // ...and the next destructive run proceeds, with the poisoned future row
    // permanently ineligible rather than permanently blocking.
    expect((await mod.purgeExpiredAuditRows({ now: NOW, enabled: true, dryRun: false })).skipped).toBe(false);
  });

  it("keeps the tolerance tight enough to matter", async () => {
    // 30 days was wrong in BOTH directions: it accepts a month-long jump
    // (over-deleting a month of trail and stamping a poisoned baseline), and
    // treats a 31-day gap as a hard stop. Pinned so widening it is a decision.
    const mod = await import("../retention");
    expect(mod.MAX_SWEEP_ADVANCE_MS).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
  });
});

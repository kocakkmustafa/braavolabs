/**
 * BRA-P0-02c-6 (c) — RLS on runs / approvals / job_receipts on a REAL Postgres.
 * Skips unless TEST_DATABASE_URL is set (see db-harness.ts).
 *
 * The policies (20260616000000_tenant_rls, 20260819010000_tenant_rls_extend,
 * 20261108000000_job_lifecycle) are FAIL-OPEN and are enforced only when BOTH
 * hold: the query runs as a NON-superuser role, and `app.tenant_id` is set on
 * that connection (transaction-local, like `tenantTx`). So this test:
 *   - seeds two tenants as the (super)user,
 *   - creates a NOSUPERUSER probe role and `SET LOCAL ROLE`s into it inside the
 *     transaction, then `set_config('app.tenant_id', <tenant>, true)`.
 * Controls prove the harness can fail: unbound probe role and a bound
 * superuser both see everything (that is exactly why enforcement needs the
 * role AND the binding).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { transitionRun } from "../../modules/run/transition";
import { dropTenants, hasTestDb, makeClient, seedRun, seedTenant, type Seed } from "./db-harness";

const d = hasTestDb ? describe : describe.skip;
const ROLE = "yula_rls_probe";

d("RLS: runs, approvals, job_receipts (real Postgres, non-superuser role)", () => {
  let db: PrismaClient;
  let A: Seed;
  let B: Seed;
  let runA: string;
  let runB: string;
  let apprA: string;
  let apprB: string;
  let rcptA: string;
  let rcptB: string;

  type Tx = Prisma.TransactionClient;
  /** Runs `fn` as the probe role, optionally bound to a tenant (tx-local, like tenantTx). */
  function asProbe<T>(tenantId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${ROLE}`);
      if (tenantId !== null) await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    });
  }

  beforeAll(async () => {
    db = makeClient();
    await db.$connect();
    const [{ rolsuper }] = await db.$queryRaw<{ rolsuper: boolean }[]>`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`;
    if (!rolsuper) throw new Error("TEST_DATABASE_URL must connect as a superuser (the test creates the probe role)");

    await db.$executeRawUnsafe(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
        CREATE ROLE ${ROLE} NOSUPERUSER NOBYPASSRLS NOINHERIT;
      END IF; END $$`);
    await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    await db.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`);

    A = await seedTenant(db, "rls-a");
    B = await seedTenant(db, "rls-b");
    runA = await seedRun(db, A, "RUNNING", "RUNNING");
    runB = await seedRun(db, B, "RUNNING", "RUNNING");
    const mkAppr = (runId: string, tenantId: string) =>
      db.approval.create({ data: { id: randomUUID(), runId, description: "rls", tenantId } }).then((a) => a.id);
    apprA = await mkAppr(runA, A.tenantId);
    apprB = await mkAppr(runB, B.tenantId);
    const mkRcpt = (runId: string, tenantId: string) =>
      db.jobReceipt.create({ data: { id: randomUUID(), runId, tenantId, outcome: "COMPLETED", contentHash: "h" } }).then((r) => r.id);
    rcptA = await mkRcpt(runA, A.tenantId);
    rcptB = await mkRcpt(runB, B.tenantId);
  });
  afterAll(async () => {
    await dropTenants(db, [A.tenantId, B.tenantId]);
    await db.$disconnect();
  });

  const bothRuns = () => ({ id: { in: [runA, runB] } });

  it("the probe role really is restricted (not superuser, no BYPASSRLS)", async () => {
    const [r] = await db.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${ROLE}`;
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  describe("READ with the wrong / right app.tenant_id", () => {
    it("tenant A bound sees only A's run, approval and receipt", async () => {
      await asProbe(A.tenantId, async (tx) => {
        expect((await tx.run.findMany({ where: bothRuns(), select: { id: true } })).map((r) => r.id)).toEqual([runA]);
        expect((await tx.approval.findMany({ where: { id: { in: [apprA, apprB] } } })).map((r) => r.id)).toEqual([apprA]);
        expect((await tx.jobReceipt.findMany({ where: { id: { in: [rcptA, rcptB] } } })).map((r) => r.id)).toEqual([rcptA]);
      });
    });

    it("tenant B bound cannot read A's run, approval or receipt by id", async () => {
      await asProbe(B.tenantId, async (tx) => {
        expect(await tx.run.findUnique({ where: { id: runA } })).toBeNull();
        expect(await tx.approval.findUnique({ where: { id: apprA } })).toBeNull();
        expect(await tx.jobReceipt.findUnique({ where: { id: rcptA } })).toBeNull();
        expect(await tx.run.count({ where: { id: runB } })).toBe(1); // its own is visible (control)
      });
    });

    it("an unknown tenant sees none of them", async () => {
      await asProbe(randomUUID(), async (tx) => {
        expect(await tx.run.count({ where: bothRuns() })).toBe(0);
        expect(await tx.approval.count({ where: { id: { in: [apprA, apprB] } } })).toBe(0);
        expect(await tx.jobReceipt.count({ where: { id: { in: [rcptA, rcptB] } } })).toBe(0);
      });
    });
  });

  describe("WRITE with the wrong app.tenant_id", () => {
    it("UPDATE of another tenant's run / approval / receipt matches nothing and changes nothing", async () => {
      await asProbe(B.tenantId, async (tx) => {
        expect((await tx.run.updateMany({ where: { id: runA }, data: { status: "FAILED" } })).count).toBe(0);
        expect((await tx.approval.updateMany({ where: { id: apprA }, data: { status: "APPROVED" } })).count).toBe(0);
        expect((await tx.jobReceipt.updateMany({ where: { id: rcptA }, data: { contentHash: "x" } })).count).toBe(0);
        expect((await tx.run.deleteMany({ where: { id: runA } })).count).toBe(0);
      });
      expect((await db.run.findUniqueOrThrow({ where: { id: runA } })).status).toBe("RUNNING");
      expect((await db.approval.findUniqueOrThrow({ where: { id: apprA } })).status).toBe("PENDING");
      expect((await db.jobReceipt.findUniqueOrThrow({ where: { id: rcptA } })).contentHash).toBe("h");
    });

    it("INSERT of a receipt / approval owned by the other tenant is rejected by the policy", async () => {
      await expect(
        asProbe(B.tenantId, (tx) =>
          tx.jobReceipt.create({ data: { id: randomUUID(), runId: runA, tenantId: A.tenantId, outcome: "FAILED", contentHash: "evil" } }),
        ),
      ).rejects.toThrow(/row-level security|violates/i);
      await expect(
        asProbe(B.tenantId, (tx) => tx.approval.create({ data: { id: randomUUID(), runId: runA, description: "evil", tenantId: A.tenantId } })),
      ).rejects.toThrow(/row-level security|violates/i);
      expect(await db.jobReceipt.count({ where: { runId: runA, contentHash: "evil" } })).toBe(0);
    });

    it("transitionRun under tenant B's binding cannot move A's run (not_found), and A's own binding can", async () => {
      // Even with the app-level tenant check pointed at A, RLS hides the row from B's connection.
      const asB = await asProbe(B.tenantId, (tx) => transitionRun(tx, runA, "PAUSED", { tenantId: A.tenantId, dualWrite: true }));
      expect(asB).toMatchObject({ ok: false, reason: "not_found" });
      expect((await db.run.findUniqueOrThrow({ where: { id: runA } })).status).toBe("RUNNING");

      const asA = await asProbe(A.tenantId, (tx) => transitionRun(tx, runA, "PAUSED", { tenantId: A.tenantId, dualWrite: true }));
      expect(asA).toMatchObject({ ok: true, noop: false });
      expect((await db.run.findUniqueOrThrow({ where: { id: runA } })).status).toBe("PAUSED");
    });
  });

  describe("controls: why enforcement needs BOTH the role and the binding", () => {
    it("FAIL-OPEN: the probe role with NO app.tenant_id bound sees both tenants", async () => {
      await asProbe(null, async (tx) => {
        expect(await tx.run.count({ where: bothRuns() })).toBe(2);
        expect(await tx.approval.count({ where: { id: { in: [apprA, apprB] } } })).toBe(2);
      });
    });

    it("a superuser bypasses RLS even with a wrong tenant bound", async () => {
      const n = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.tenant_id', ${B.tenantId}, true)`;
        return tx.run.count({ where: bothRuns() });
      });
      expect(n).toBe(2);
    });
  });
});

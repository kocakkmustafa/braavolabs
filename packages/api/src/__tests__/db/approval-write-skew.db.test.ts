/**
 * BRA-P0-02c-6 / ADR-0002 (g) — A/B concurrent approval "write skew" on a REAL
 * Postgres. Skips unless TEST_DATABASE_URL is set (see db-harness.ts).
 *
 * Scenario (JOB_STATE_DUAL_WRITE on): a run in WAITING_APPROVAL has two PENDING
 * gating approvals A and B. Two operators approve A and B at the same moment.
 * Each `decide` transaction claims its own approval, then asks `driveApprovedRun`
 * whether another gate is still PENDING. Under READ COMMITTED neither claim is
 * visible to the other transaction until commit, so without serialisation each
 * sees the other still PENDING, neither starts the run, and the run stays in
 * WAITING_APPROVAL with NO open approval (stuck).
 *
 * The test reproduces the interleaving deterministically: both transactions
 * claim, wait at a barrier until both have claimed, then both call the real
 * `driveApprovedRun` from approval/router.ts. Expected (correct) outcome:
 * exactly one transaction starts the run (enqueue true), the run ends RUNNING.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { barrier, bindEnvToTestDb, dropTenants, hasTestDb, makeClient, seedRun, seedTenant, type Seed } from "./db-harness";

bindEnvToTestDb();
const d = hasTestDb ? describe : describe.skip;

d("A/B concurrent approve (real Postgres, dual write ON)", () => {
  let db: PrismaClient;
  let seed: Seed;
  let driveApprovedRun: typeof import("../../modules/approval/router").driveApprovedRun;

  beforeAll(async () => {
    db = makeClient();
    await db.$connect();
    seed = await seedTenant(db, "skew");
    ({ driveApprovedRun } = await import("../../modules/approval/router"));
  });
  afterEach(() => { delete process.env.JOB_STATE_DUAL_WRITE; });
  afterAll(async () => {
    await dropTenants(db, [seed.tenantId]);
    await db.$disconnect();
  });

  async function approveBoth(): Promise<{ runId: string; enqueues: boolean[]; status: string; pending: number }> {
    process.env.JOB_STATE_DUAL_WRITE = "true";
    const runId = await seedRun(db, seed, "WAITING_APPROVAL", "NEEDS_APPROVAL");
    const ids = await Promise.all(
      [0, 1].map(() => db.approval.create({ data: { id: randomUUID(), runId, description: "gate", type: "SPEND", tenantId: seed.tenantId } }).then((a) => a.id)),
    );
    const gate = barrier(2);
    const enqueues = await Promise.all(
      ids.map((id) =>
        db.$transaction(async (tx) => {
          const claim = await tx.approval.updateMany({ where: { id, status: "PENDING" }, data: { status: "APPROVED", decidedAt: new Date() } });
          expect(claim.count).toBe(1);
          await gate(); // both operators have claimed; neither has committed
          return driveApprovedRun(tx, id, runId, seed.tenantId);
        }),
      ),
    );
    const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
    const pending = await db.approval.count({ where: { runId, status: "PENDING" } });
    return { runId, enqueues, status: run.status, pending };
  }

  it("both approved concurrently: exactly one starts the run and it ends RUNNING (not stuck in WAITING_APPROVAL)", async () => {
    const r = await approveBoth();
    expect(r.pending).toBe(0);
    expect(r.enqueues.filter(Boolean)).toHaveLength(1);
    expect(r.status).toBe("RUNNING");
  });

  it("repeated 5x: never stuck, never two starts", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await approveBoth();
      expect(r.enqueues.filter(Boolean), `iteration ${i}`).toHaveLength(1);
      expect(r.status).toBe("RUNNING");
    }
  });
});

/**
 * BRA-P0-02c-6 (a) — `transitionRun` compare-and-set race on a REAL Postgres.
 * Skips unless TEST_DATABASE_URL is set (see db-harness.ts).
 *
 * Two interactive transactions on two pooled connections both READ the same
 * status, wait at a barrier until both have read, then both try to WRITE. The
 * second UPDATE blocks on the row lock until the first commits, re-evaluates
 * its `status = <read value>` predicate on the new row version and matches
 * nothing: exactly one winner, the loser answers `lost_race` (the outcome the
 * ticket calls "lost").
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { transitionRun, type RunTransitionClient, type TransitionOutcome } from "../../modules/run/transition";
import type { JobState } from "../../modules/run/job-state";
import { barrier, dropTenants, hasTestDb, makeClient, seedRun, seedTenant, type Seed } from "./db-harness";

/** Gate for the dedicated CI job: a silent skip there would look green. */
it("the DB-backed group must actually run in the dedicated CI gate", () => {
  if (process.env.REQUIRE_DB_TESTS === "1") {
    expect(process.env.TEST_DATABASE_URL, "TEST_DATABASE_URL is unset in the DB test gate: the real-Postgres tests would silently skip").toBeTruthy();
  }
});

const d = hasTestDb ? describe : describe.skip;

d("transitionRun CAS race (real Postgres)", () => {
  let db: PrismaClient;
  let seed: Seed;
  const tenants: string[] = [];

  beforeAll(async () => {
    db = makeClient();
    await db.$connect();
    seed = await seedTenant(db, "cas");
    tenants.push(seed.tenantId);
  });
  afterAll(async () => {
    await dropTenants(db, tenants);
    await db.$disconnect();
  });

  /** Fires `targets.length` transitions concurrently, each holding its read until all have read. */
  async function race(runId: string, targets: JobState[], dualWrite: boolean): Promise<TransitionOutcome[]> {
    const gate = barrier(targets.length);
    return Promise.all(
      targets.map((to) =>
        db.$transaction(async (tx) => {
          const client: RunTransitionClient = {
            run: {
              findFirst: async (args) => {
                const row = await tx.run.findFirst(args);
                await gate(); // every contender has read before any writes
                return row;
              },
              updateMany: (args) => tx.run.updateMany(args),
            },
          };
          return transitionRun(client, runId, to, { tenantId: seed.tenantId, dualWrite });
        }),
      ),
    );
  }

  for (const dual of [false, true]) {
    const mode = dual ? "dual write ON" : "dual write OFF";

    it(`${mode}: two writers, same target: one wins, one lost_race`, async () => {
      const runId = await seedRun(db, seed, "RUNNING", dual ? "RUNNING" : null);
      const out = await race(runId, ["COMPLETED", "COMPLETED"], dual);
      expect(out.filter((o) => o.ok)).toHaveLength(1);
      const lost = out.filter((o) => !o.ok);
      expect(lost).toHaveLength(1);
      expect(lost[0]).toMatchObject({ ok: false, reason: "lost_race" });
      const row = await db.run.findUniqueOrThrow({ where: { id: runId } });
      expect(row.status).toBe("COMPLETED");
      if (dual) expect(row.state).toBe("COMPLETED");
    });

    it(`${mode}: two writers, different targets (COMPLETED vs FAILED): exactly one lands`, async () => {
      const runId = await seedRun(db, seed, "RUNNING", dual ? "RUNNING" : null);
      const out = await race(runId, ["COMPLETED", "FAILED"], dual);
      const winners = out.filter((o): o is Extract<TransitionOutcome, { ok: true }> => o.ok);
      expect(winners).toHaveLength(1);
      expect(out.filter((o) => !o.ok)[0]).toMatchObject({ reason: "lost_race" });
      const row = await db.run.findUniqueOrThrow({ where: { id: runId } });
      expect(row.status).toBe(winners[0].to);
    });

    it(`${mode}: eight concurrent writers: exactly one winner, seven lost_race`, async () => {
      const runId = await seedRun(db, seed, "RUNNING", dual ? "RUNNING" : null);
      const out = await race(runId, Array<JobState>(8).fill("FAILED"), dual);
      expect(out.filter((o) => o.ok)).toHaveLength(1);
      expect(out.filter((o) => !o.ok && o.reason === "lost_race")).toHaveLength(7);
    });
  }

  it("a transition that loses to a committed write does not overwrite it (sequential control)", async () => {
    const runId = await seedRun(db, seed, "RUNNING", null);
    const first = await db.$transaction((tx) => transitionRun(tx, runId, "COMPLETED", { tenantId: seed.tenantId, dualWrite: false }));
    expect(first).toMatchObject({ ok: true, noop: false });
    // COMPLETED is terminal: the second writer is refused by the graph, not by the CAS.
    const second = await db.$transaction((tx) => transitionRun(tx, runId, "FAILED", { tenantId: seed.tenantId, dualWrite: false }));
    expect(second).toMatchObject({ ok: false, reason: "illegal_transition" });
    expect((await db.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe("COMPLETED");
  });

  it("another tenant's run is not_found (tenant scope on the read)", async () => {
    const other = await seedTenant(db, "cas-other");
    tenants.push(other.tenantId);
    const runId = await seedRun(db, other, "RUNNING", null);
    const o = await db.$transaction((tx) => transitionRun(tx, runId, "COMPLETED", { tenantId: seed.tenantId, dualWrite: false }));
    expect(o).toMatchObject({ ok: false, reason: "not_found" });
    expect((await db.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe("RUNNING");
  });
});

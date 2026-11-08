/**
 * BRA-P0-02c-6 (b) — exact-action `consumeGrant` race on a REAL Postgres.
 * Skips unless TEST_DATABASE_URL is set (see db-harness.ts).
 *
 * Every contender reads the candidate grants, waits at a barrier until all have
 * read, then claims. The claim is a scalar UPDATE `… AND consumed_at IS NULL`
 * that re-checks on the locked row, so one grant is spent exactly once.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { consumeGrant, computeActionHash, generateNonce, type GrantClient } from "../../modules/approval/exact-action";
import { barrier, dropTenants, hasTestDb, makeClient, seedRun, seedTenant, type Seed } from "./db-harness";

const d = hasTestDb ? describe : describe.skip;

d("consumeGrant race (real Postgres)", () => {
  let db: PrismaClient;
  let seed: Seed;
  let runId: string;

  beforeAll(async () => {
    db = makeClient();
    await db.$connect();
    seed = await seedTenant(db, "grant");
    runId = await seedRun(db, seed, "WAITING_APPROVAL", "NEEDS_APPROVAL");
  });
  afterAll(async () => {
    await dropTenants(db, [seed.tenantId]);
    await db.$disconnect();
  });

  function action(input: unknown) {
    return { tenantId: seed.tenantId, runId, type: "SPEND", toolName: "ad_spend", input, amountUsd: 5 };
  }

  async function seedGrant(actionHash: string, decidedAtOffsetMs = 0): Promise<string> {
    const a = await db.approval.create({
      data: {
        id: randomUUID(),
        runId,
        type: "SPEND",
        status: "APPROVED",
        description: "grant",
        tenantId: seed.tenantId,
        nonce: generateNonce(),
        actionHash,
        decidedAt: new Date(Date.now() + decidedAtOffsetMs),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    return a.id;
  }

  /** `n` contenders, each on its own transaction/connection, all reading before any claims. */
  async function contend(n: number, hash: string) {
    const gate = barrier(n);
    return Promise.all(
      Array.from({ length: n }, () =>
        db.$transaction(async (tx) => {
          const client: GrantClient = {
            approval: {
              findMany: async (args) => {
                const rows = await tx.approval.findMany(args);
                await gate();
                return rows;
              },
              updateMany: (args) => tx.approval.updateMany(args),
            },
          };
          return consumeGrant(client, { tenantId: seed.tenantId, runId, actionHash: hash });
        }),
      ),
    );
  }

  it("two concurrent consumers of ONE grant: exactly one wins, the loser is already_consumed", async () => {
    const hash = computeActionHash(action({ n: 1 }));
    const id = await seedGrant(hash);
    const out = await contend(2, hash);
    const wins = out.filter((o) => o.ok);
    expect(wins).toHaveLength(1);
    expect(wins[0]).toMatchObject({ ok: true, approvalId: id });
    expect(out.filter((o) => !o.ok)[0]).toMatchObject({ ok: false, reason: "already_consumed" });
    const row = await db.approval.findUniqueOrThrow({ where: { id } });
    expect(row.consumedAt).not.toBeNull();
  });

  it("six concurrent consumers of ONE grant: exactly one winner", async () => {
    const hash = computeActionHash(action({ n: 2 }));
    await seedGrant(hash);
    const out = await contend(6, hash);
    expect(out.filter((o) => o.ok)).toHaveLength(1);
    expect(out.filter((o) => !o.ok)).toHaveLength(5);
  });

  it("two grants for the same action, three consumers: each grant is spent once, the third loses", async () => {
    const hash = computeActionHash(action({ n: 3 }));
    const g1 = await seedGrant(hash, 0);
    const g2 = await seedGrant(hash, 1);
    const out = await contend(3, hash);
    const wonIds = out.flatMap((o) => (o.ok ? [o.approvalId] : [])).sort();
    expect(wonIds).toEqual([g1, g2].sort()); // distinct grants, no double spend
    expect(out.filter((o) => !o.ok)).toHaveLength(1);
  });

  it("a spent grant stays spent for a later sequential consumer", async () => {
    const hash = computeActionHash(action({ n: 4 }));
    await seedGrant(hash);
    expect((await contend(1, hash))[0].ok).toBe(true);
    const again = (await contend(1, hash))[0];
    expect(again).toMatchObject({ ok: false });
  });
});

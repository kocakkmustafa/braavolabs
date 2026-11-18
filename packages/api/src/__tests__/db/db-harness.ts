/**
 * BRA-P0-02c-6 — shared harness for the real-Postgres tests (`*.db.test.ts`).
 *
 * These tests run ONLY when TEST_DATABASE_URL points at a THROWAWAY database
 * that already has every migration applied (`prisma migrate deploy`, NOT
 * `db push`: the RLS policies live in the migrations). Without the variable
 * each `*.db.test.ts` skips itself, so a laptop `pnpm test` needs no database.
 *
 * HOW TO RUN LOCALLY (throwaway database only, never a real environment):
 *
 *   createdb aicos_dbtest && psql -d aicos_dbtest -c 'CREATE EXTENSION IF NOT EXISTS vector;'
 *   DATABASE_URL=postgresql://$USER@localhost:5432/aicos_dbtest \
 *     pnpm --filter @ai-company-os/db exec prisma migrate deploy
 *   TEST_DATABASE_URL=postgresql://$USER@localhost:5432/aicos_dbtest \
 *     pnpm --filter @ai-company-os/api test:db
 *
 * The connecting role must be a superuser (the RLS test creates a NOSUPERUSER
 * probe role and `SET LOCAL ROLE`s into it). Rows are tenant-scoped with random
 * ids and removed in `afterAll`, best effort.
 */
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL;

/** `describe` when a test database is configured, `describe.skip` otherwise. */
export const hasTestDb = Boolean(TEST_DB_URL);

/** Real routers/`env.ts` read DATABASE_URL at import; only point it at the test DB when one is configured. */
export function bindEnvToTestDb(): void {
  if (!TEST_DB_URL) return;
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.JWT_SECRET ??= "db-test-secret-at-least-32-chars-long-xxxx";
  process.env.ENCRYPTION_KEY ??= "0".repeat(32);
  process.env.NODE_ENV = "test";
}

/** A client with enough pooled connections for several concurrent interactive transactions. */
export function makeClient(): PrismaClient {
  const u = new URL(TEST_DB_URL!);
  u.searchParams.set("connection_limit", "12");
  u.searchParams.set("pool_timeout", "20");
  return new PrismaClient({ datasources: { db: { url: u.toString() } } });
}

/** Resolves once `n` callers have reached it (all callers then proceed together). */
export function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return async () => {
    arrived += 1;
    if (arrived >= n) release();
    await gate;
  };
}

export interface Seed {
  tenantId: string;
  companyId: string;
  pipelineId: string;
}

export async function seedTenant(db: PrismaClient, label: string): Promise<Seed> {
  const tenantId = randomUUID();
  await db.tenant.create({
    data: { id: tenantId, name: `T-${label}`, slug: `t-${label}-${tenantId.slice(0, 8)}`, plan: "INDIVIDUAL" },
  });
  const company = await db.company.create({
    data: { id: randomUUID(), tenantId, name: `Co-${label}`, slug: `co-${label}-${tenantId.slice(0, 8)}`, status: "ACTIVE" },
  });
  const pipeline = await db.pipeline.create({
    data: { id: randomUUID(), companyId: company.id, name: `P-${label}`, trigger: "MANUAL", steps: [] as never },
  });
  return { tenantId, companyId: company.id, pipelineId: pipeline.id };
}

export async function seedRun(
  db: PrismaClient,
  seed: Seed,
  status: "RUNNING" | "WAITING_APPROVAL" | "PAUSED" | "FAILED" | "COMPLETED" | "PENDING",
  state: "RUNNING" | "NEEDS_APPROVAL" | "PAUSED" | "FAILED" | "COMPLETED" | null = null,
): Promise<string> {
  const run = await db.run.create({
    data: {
      id: randomUUID(),
      pipelineId: seed.pipelineId,
      status,
      ...(state ? { state } : {}),
      tenantId: seed.tenantId,
      workspaceId: seed.companyId,
    },
  });
  return run.id;
}

export async function dropTenants(db: PrismaClient, tenantIds: string[]): Promise<void> {
  for (const id of tenantIds) {
    // Cascades: tenant → company → pipeline → run → approval / receipts.
    await db.tenant.delete({ where: { id } }).catch(() => undefined);
  }
}

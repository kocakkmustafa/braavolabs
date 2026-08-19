/**
 * LIVE proof for BR-P0-003 — entitlement-ledger.service.ts against a REAL
 * Postgres database (not mocked). The unit tests in
 * billing/__tests__/entitlement-ledger.service.test.ts mock `prisma`
 * entirely, so they prove the SERVICE'S OWN LOGIC is correct given
 * whatever Prisma returns — they cannot prove the actual unique
 * constraint on (source, source_event_id) really dedupes a redelivered
 * webhook. This script is the missing half: it runs the real Postgres
 * unique-constraint path and the roadmap's explicit acceptance bar
 * ("duplicate event → tek ledger effect", full lifecycle, out-of-order
 * delivery) against a live database.
 *
 * This is a manual/CI-adjacent check, not a permanent part of `pnpm
 * test` — same convention as the other scripts in this directory
 * (handoff-e2e-setup.ts etc). Wiring a Postgres service container into
 * the shared CI `test` job (which today deliberately runs DB-free, see
 * ci.yml's own comment) is BR-P0-005's territory ("CI/E2E gates"), not
 * smuggled in here.
 *
 * Usage (isolated DB — NEVER aicos_dev):
 *   DATABASE_URL="postgresql://aicos:<pw>@localhost:5433/aicos_entitlement_ledger_demo?schema=public" \
 *     pnpm --filter api exec tsx scripts/live/entitlement-ledger-demo.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  appendEntitlementEvent,
  recordEntitlementEvent,
  reprojectEntitlement,
} from "../../src/modules/billing/entitlement-ledger.service";

const dbUrl = process.env.DATABASE_URL ?? "";
if (!/aicos_entitlement_ledger_demo/.test(dbUrl)) {
  throw new Error(
    "REFUSING to run: DATABASE_URL must target the isolated aicos_entitlement_ledger_demo DB " +
      "(got: " + dbUrl.replace(/:[^:@]+@/, ":***@") + "). This script writes and deletes real rows.",
  );
}

const prisma = new PrismaClient();

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "✓" : "✗ FAIL"} ${label}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

async function freshTenant(slug: string) {
  return prisma.tenant.create({ data: { name: slug, slug } });
}

async function main() {
  console.log("=== BR-P0-003 live proof — real Postgres, no mocks ===\n");

  // ── 1. Duplicate delivery → single ledger row, single observable effect ──
  console.log("--- Test 1: duplicate event delivery ---");
  const t1 = await freshTenant(`br-p0-003-dup-${Date.now()}`);
  const dupInput = {
    tenantId: t1.id,
    source: "stripe" as const,
    streamId: "sub-dup-1",
    sourceEventId: "evt-dup-1",
    sourceTimestamp: new Date("2026-01-01T00:00:00Z"),
    type: "purchase" as const,
    planTier: "PRO",
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
    autoRenew: true,
  };
  const first = await appendEntitlementEvent(dupInput);
  const second = await appendEntitlementEvent(dupInput); // exact redelivery
  check("first delivery inserts", first, true);
  check("redelivery is rejected by the unique constraint (not silently re-inserted)", second, false);
  const rowCount = await prisma.entitlementEvent.count({ where: { tenantId: t1.id } });
  check("exactly ONE row exists after two identical deliveries", rowCount, 1);
  const planAfterDup = await reprojectEntitlement(t1.id);
  check("plan reflects the (single) event correctly", planAfterDup, "PRO");

  // ── 2. Out-of-order delivery — a DELAYED old event must not overwrite a newer state ──
  console.log("\n--- Test 2: out-of-order delivery (the actual bug this system fixes) ---");
  const t2 = await freshTenant(`br-p0-003-ooo-${Date.now()}`);
  // Newer event arrives FIRST (network reordering / retry backlog).
  await recordEntitlementEvent({
    tenantId: t2.id,
    source: "stripe",
    streamId: "sub-ooo-1",
    sourceEventId: "evt-ooo-new",
    sourceTimestamp: new Date("2026-03-01T00:00:00Z"), // newer
    type: "renewal",
    planTier: "BUSINESS",
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
    autoRenew: true,
  });
  // Older event (a delayed webhook retry) arrives SECOND, chronologically stale.
  const planAfterStaleArrival = await recordEntitlementEvent({
    tenantId: t2.id,
    source: "stripe",
    streamId: "sub-ooo-1",
    sourceEventId: "evt-ooo-old",
    sourceTimestamp: new Date("2026-01-01T00:00:00Z"), // older
    type: "purchase",
    planTier: "CREATOR",
    expiresAt: new Date("2026-02-01T00:00:00Z"),
    autoRenew: true,
  });
  check(
    "a late-arriving OLD event does not downgrade a chronologically NEWER state — this is the exact class of bug the 6 direct-write call sites had (unconditional UPDATE, last-writer-wins by ARRIVAL not by TIME)",
    planAfterStaleArrival,
    "BUSINESS",
  );

  // ── 3. Full lifecycle matrix ──
  console.log("\n--- Test 3: full lifecycle (purchase → renewal → cancel → grace → refund → restore) ---");
  const t3 = await freshTenant(`br-p0-003-lifecycle-${Date.now()}`);
  const stream = "sub-lifecycle-1";
  let seq = 0;
  const next = () => new Date(Date.UTC(2026, 0, 1 + seq++));

  await recordEntitlementEvent({
    tenantId: t3.id, source: "stripe", streamId: stream,
    sourceEventId: "lc-purchase", sourceTimestamp: next(), type: "purchase",
    planTier: "CREATOR", expiresAt: new Date(Date.now() + 30 * 86_400_000), autoRenew: true,
  });
  check("purchase → CREATOR", (await prisma.tenant.findUniqueOrThrow({ where: { id: t3.id } })).plan, "CREATOR");

  await recordEntitlementEvent({
    tenantId: t3.id, source: "stripe", streamId: stream,
    sourceEventId: "lc-renewal-upgrade", sourceTimestamp: next(), type: "renewal",
    planTier: "PRO", expiresAt: new Date(Date.now() + 30 * 86_400_000), autoRenew: true,
  });
  check("renewal (upgrade) → PRO", (await prisma.tenant.findUniqueOrThrow({ where: { id: t3.id } })).plan, "PRO");

  await recordEntitlementEvent({
    tenantId: t3.id, source: "stripe", streamId: stream,
    sourceEventId: "lc-cancel", sourceTimestamp: next(), type: "cancel",
    planTier: null, expiresAt: null, autoRenew: false,
  });
  check(
    "cancel (auto-renew off) does NOT immediately downgrade — tenant keeps what they paid for until expiry",
    (await prisma.tenant.findUniqueOrThrow({ where: { id: t3.id } })).plan,
    "PRO",
  );

  await recordEntitlementEvent({
    tenantId: t3.id, source: "stripe", streamId: stream,
    sourceEventId: "lc-grace", sourceTimestamp: next(), type: "grace",
    planTier: null, expiresAt: null, autoRenew: false,
  });
  check(
    "grace period still GRANTS access (payment retry window, not yet lost)",
    (await prisma.tenant.findUniqueOrThrow({ where: { id: t3.id } })).plan,
    "PRO",
  );

  await recordEntitlementEvent({
    tenantId: t3.id, source: "stripe", streamId: stream,
    sourceEventId: "lc-refund", sourceTimestamp: next(), type: "refund",
    planTier: null, expiresAt: null, autoRenew: false,
  });
  check(
    "refund → immediate FREE",
    (await prisma.tenant.findUniqueOrThrow({ where: { id: t3.id } })).plan,
    "FREE",
  );

  await recordEntitlementEvent({
    tenantId: t3.id, source: "stripe", streamId: stream,
    sourceEventId: "lc-restore", sourceTimestamp: next(), type: "restore",
    planTier: "PRO", expiresAt: new Date(Date.now() + 30 * 86_400_000), autoRenew: true,
  });
  check(
    "restore → PRO again",
    (await prisma.tenant.findUniqueOrThrow({ where: { id: t3.id } })).plan,
    "PRO",
  );

  // ── 4. Multi-source combine — Stripe refunded, mobile (Apple) still active ──
  console.log("\n--- Test 4: multi-source combine (the 3x-duplicated 'don't downgrade' check, now unified) ---");
  const t4 = await freshTenant(`br-p0-003-multisource-${Date.now()}`);
  await recordEntitlementEvent({
    tenantId: t4.id, source: "stripe", streamId: "sub-ms-1",
    sourceEventId: "ms-stripe-purchase", sourceTimestamp: new Date("2026-01-01T00:00:00Z"),
    type: "purchase", planTier: "PRO", expiresAt: new Date(Date.now() + 30 * 86_400_000), autoRenew: true,
  });
  await recordEntitlementEvent({
    tenantId: t4.id, source: "apple", streamId: "orig-tx-ms-1",
    sourceEventId: "ms-apple-purchase", sourceTimestamp: new Date("2026-01-02T00:00:00Z"),
    type: "purchase", planTier: "BUSINESS", expiresAt: new Date(Date.now() + 30 * 86_400_000), autoRenew: true,
  });
  check(
    "both streams active → highest tier (BUSINESS) governs",
    (await prisma.tenant.findUniqueOrThrow({ where: { id: t4.id } })).plan,
    "BUSINESS",
  );
  await recordEntitlementEvent({
    tenantId: t4.id, source: "stripe", streamId: "sub-ms-1",
    sourceEventId: "ms-stripe-refund", sourceTimestamp: new Date("2026-01-03T00:00:00Z"),
    type: "refund", planTier: null, expiresAt: null, autoRenew: false,
  });
  check(
    "Stripe stream refunded, Apple mobile sub still active → plan stays BUSINESS, not FREE (this is the exact fix for router.ts:722-751's manual 'stillActive' check, now generalized across all 3 sources)",
    (await prisma.tenant.findUniqueOrThrow({ where: { id: t4.id } })).plan,
    "BUSINESS",
  );

  // ── cleanup ──
  const tenantIds = [t1.id, t2.id, t3.id, t4.id];
  await prisma.entitlementEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });

  console.log(`\n=== ${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main()
  .catch((err) => {
    console.error("Script crashed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  migrateSubscriptionProjection,
  resolveIapProductPlan,
  type SubscriptionMigrationRow,
} from "../entitlement-mapping";

const migrationPath = fileURLToPath(
  new URL("../../../../../db/prisma/migrations/20260821_subscription_only_plans/migration.sql", import.meta.url),
);
const schemaPath = fileURLToPath(new URL("../../../../../db/prisma/schema.prisma", import.meta.url));
const migrationSql = readFileSync(migrationPath, "utf8");
const schema = readFileSync(schemaPath, "utf8");

describe("additive tenant plan migration", () => {
  const fixtures: Array<[string, string, SubscriptionMigrationRow["migrationState"]]> = [
    ["FREE", "MANUAL_REVIEW", "manual_review"],
    ["CREATOR", "INDIVIDUAL", "mapped"],
    ["PRO", "TEAM", "mapped"],
    ["BUSINESS", "MANUAL_REVIEW", "manual_review"],
    ["ENTERPRISE", "MANUAL_REVIEW", "manual_review"],
    ["UNKNOWN", "MANUAL_REVIEW", "manual_review"],
  ];

  it.each(fixtures)("maps legacy %s to %s with state %s", (legacy, expectedPlan, expectedState) => {
    const out = migrateSubscriptionProjection({ plan: legacy, legacyPlan: null, migrationState: "pending" });
    expect(out).toEqual({ plan: expectedPlan, legacyPlan: legacy, migrationState: expectedState });
  });

  it("is idempotent across duplicate replay and input order", () => {
    const rows = fixtures.map(([plan]) => ({ plan, legacyPlan: null, migrationState: "pending" as const }));
    const forward = rows.map(migrateSubscriptionProjection);
    const reversed = [...rows].reverse().map(migrateSubscriptionProjection).reverse();
    expect(reversed).toEqual(forward);
    expect(forward.map(migrateSubscriptionProjection)).toEqual(forward);
  });

  it("resumes a partial migration from the preserved legacy identity and never rewrites a completed row", () => {
    expect(
      migrateSubscriptionProjection({ plan: "MANUAL_REVIEW", legacyPlan: "PRO", migrationState: "pending" }),
    ).toEqual({ plan: "TEAM", legacyPlan: "PRO", migrationState: "mapped" });

    const completed = { plan: "INDIVIDUAL", legacyPlan: "CREATOR", migrationState: "mapped" as const };
    expect(migrateSubscriptionProjection(completed)).toEqual(completed);
  });

  it("keeps the SQL additive, snapshots legacy data before projection, and has no down/destructive statement", () => {
    expect(migrationSql).toMatch(/ADD VALUE IF NOT EXISTS 'INDIVIDUAL'/);
    expect(migrationSql).toMatch(/ADD VALUE IF NOT EXISTS 'TEAM'/);
    expect(migrationSql).toMatch(/ADD VALUE IF NOT EXISTS 'MANUAL_REVIEW'/);
    expect(migrationSql.indexOf('SET "legacy_plan" = "plan"::TEXT')).toBeLessThan(
      migrationSql.indexOf('WHEN \'CREATOR\' THEN \'INDIVIDUAL\''),
    );
    expect(migrationSql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE)\b/i);
    expect(migrationSql).toMatch(/ALTER COLUMN "plan" SET DEFAULT 'MANUAL_REVIEW'/);
  });

  it("keeps Prisma and SQL enum/default contracts aligned", () => {
    for (const plan of ["INDIVIDUAL", "TEAM", "MANUAL_REVIEW", "FREE", "CREATOR", "PRO", "BUSINESS", "ENTERPRISE"]) {
      expect(schema).toMatch(new RegExp(`\\n\\s+${plan}\\n`));
    }
    expect(schema).toMatch(/plan\s+Plan\s+@default\(MANUAL_REVIEW\)/);
    expect(schema).toContain('@map("legacy_plan")');
    expect(schema).toContain('@map("subscription_migration_state")');
  });
});

describe("legacy receipt replay", () => {
  it("is deterministic for every known old SKU and fails unknown/ambiguous receipts closed", () => {
    const cases = [
      ["com.braavolabs.creator.monthly", "INDIVIDUAL"],
      ["com.braavolabs.creator.yearly", "INDIVIDUAL"],
      ["com.braavolabs.pro.monthly", "TEAM"],
      ["com.braavolabs.pro.yearly", "TEAM"],
      ["com.braavolabs.team.monthly", "TEAM"],
      ["com.braavolabs.team.yearly", "TEAM"],
      ["com.braavolabs.business.monthly", "MANUAL_REVIEW"],
      ["com.braavolabs.enterprise.yearly", "MANUAL_REVIEW"],
      ["tampered.product", undefined],
    ] as const;
    for (const [sku, expected] of cases) {
      expect(resolveIapProductPlan(sku)).toBe(expected);
      expect(resolveIapProductPlan(sku)).toBe(expected);
    }
  });
});

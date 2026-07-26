import { describe, it, expect } from "vitest";
import { buildActivityWhere, READ_ACTION_SUFFIXES } from "../router";

/**
 * `/dashboard/activity` feeds a user-facing "what happened" surface, not an
 * audit console. Because the clients poll `/companies` on several screens,
 * the audit log fills with `company.list`: measured against the live App
 * Review tenant on 2026-07-26, 99 of the 100 most recent rows were that one
 * action. These tests pin the filter that keeps the feed about the business.
 */

const matchesAnySuffix = (action: string) =>
  READ_ACTION_SUFFIXES.some((s) => action.endsWith(s));

describe("buildActivityWhere", () => {
  it("excludes the read that flooded the feed", () => {
    expect(matchesAnySuffix("company.list")).toBe(true);
    const where = buildActivityWhere("t1", false) as { AND: unknown[] };
    expect(where.AND).toContainEqual({ NOT: { action: { endsWith: ".list" } } });
  });

  it("keeps every business event", () => {
    for (const a of [
      "run.completed",
      "run.execute",
      "run.fail",
      "run_step.complete",
      "approval.requested",
      "approval.decide",
      "draft.publish",
      "company.create",
      "company.build",
      "integration.save",
      "governance.cost_anomaly",
    ]) {
      expect(matchesAnySuffix(a)).toBe(false);
    }
  });

  it("keeps auth.login — a sign-in is a security signal the owner should see", () => {
    expect(matchesAnySuffix("auth.login")).toBe(false);
    expect(matchesAnySuffix("auth.logout")).toBe(false);
  });

  it("matches the verb, not a substring of the resource", () => {
    // ".list" must not swallow "catalog.listing_created".
    expect(matchesAnySuffix("catalog.listing_created")).toBe(false);
    expect(matchesAnySuffix("budget.reset")).toBe(false);
  });

  it("scopes to the tenant in both modes — filtering must never widen access", () => {
    expect(buildActivityWhere("t1", false)).toMatchObject({ tenantId: "t1" });
    expect(buildActivityWhere("t1", true)).toEqual({ tenantId: "t1" });
  });

  it("includeReads returns the raw audit stream for a future audit view", () => {
    expect(buildActivityWhere("t1", true)).not.toHaveProperty("AND");
  });

  it("the row query and the count query must share one where", () => {
    // A total computed without the filter would make pagination lie about
    // how much is left to page through.
    const a = buildActivityWhere("t1", false);
    const b = buildActivityWhere("t1", false);
    expect(a).toEqual(b);
  });
});

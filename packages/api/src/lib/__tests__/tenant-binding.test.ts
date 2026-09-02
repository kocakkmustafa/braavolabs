import { describe, it, expect } from "vitest";
import { resolveTenantBinding } from "../tenant-binding";
import { TenantContextError } from "../tenant-context";

/**
 * BR-P0-004 slice 3 — the fail-closed rule, as a pure decision.
 *
 * Slice 2 made "deliberately tenant-less" distinguishable from "nobody said
 * anything". This is what finally acts on that distinction:
 *
 *   tenant   → bind app.tenant_id on the query's connection (RLS enforced)
 *   system   → pass through unwrapped (today's behavior, explicitly declared)
 *   NOTHING  → throw, instead of silently querying with RLS disabled
 *
 * Kept as a pure function rather than inline in db.ts so the decision can be
 * tested exhaustively without a Postgres, and so the error text — which is what
 * an on-call operator actually reads — is pinned.
 */
describe("resolveTenantBinding", () => {
  it("binds when a tenant context is present", () => {
    expect(resolveTenantBinding({ kind: "tenant", tenantId: "t1" }, { failClosed: true })).toEqual({
      mode: "bind",
      tenantId: "t1",
    });
  });

  it("passes through for an explicitly system-scoped path", () => {
    expect(
      resolveTenantBinding({ kind: "system", reason: "worker:pipeline-runs" }, { failClosed: true }),
    ).toEqual({ mode: "passthrough", reason: "worker:pipeline-runs" });
  });

  it("THROWS on an unmarked context — the whole point of the slice", () => {
    expect(() => resolveTenantBinding(undefined, { failClosed: true })).toThrow(TenantContextError);
  });

  it("names the operation so an operator can find the call site", () => {
    expect(() =>
      resolveTenantBinding(undefined, { failClosed: true, model: "User", operation: "findMany" }),
    ).toThrow(/User\.findMany/);
  });

  it("tells the operator how to fix it, not just that it broke", () => {
    let msg = "";
    try {
      resolveTenantBinding(undefined, { failClosed: true });
    } catch (e) { msg = (e as Error).message; }
    // An error that only says "no tenant context" sends the reader to the
    // source. Name both remedies.
    expect(msg).toMatch(/runWithTenant/);
    expect(msg).toMatch(/runWithoutTenant/);
  });

  it("degrades to today's pass-through when the kill switch is off", () => {
    // TENANT_CONTEXT_FAIL_CLOSED=false lets an operator disable enforcement
    // without a code change or rollback if an unmarked path is discovered in
    // production. Deliberately NOT the default.
    expect(resolveTenantBinding(undefined, { failClosed: false })).toEqual({
      mode: "passthrough",
      reason: "unmarked (fail-closed disabled)",
    });
  });

  it("still binds and still passes through with the kill switch off", () => {
    // The switch relaxes ONLY the unmarked case; it must not turn RLS binding
    // off for real tenant requests.
    expect(resolveTenantBinding({ kind: "tenant", tenantId: "t1" }, { failClosed: false })).toEqual({
      mode: "bind",
      tenantId: "t1",
    });
    expect(resolveTenantBinding({ kind: "system", reason: "cron:x" }, { failClosed: false })).toEqual(
      { mode: "passthrough", reason: "cron:x" },
    );
  });
});

/**
 * tenantTx is declared `Promise<T>`, so a failure must arrive as a REJECTION.
 * A synchronous throw would bypass a caller's `.catch()` and surface as an
 * uncaught exception — turning a contained 500 into a process-level event.
 */
describe("tenantTx failure shape", () => {
  it("rejects (not throws) when the context is unmarked", async () => {
    const { tenantTx } = await import("../db");
    let threwSynchronously = false;
    let p: Promise<unknown> | undefined;
    try {
      p = tenantTx(async () => "never runs");
    } catch {
      threwSynchronously = true;
    }
    expect(threwSynchronously).toBe(false);
    await expect(p).rejects.toThrow(TenantContextError);
  });

  it("the caller's own .catch() is enough to contain it", async () => {
    const { tenantTx } = await import("../db");
    const caught = await tenantTx(async () => "x").catch((e) => (e as Error).name);
    expect(caught).toBe("TenantContextError");
  });
});

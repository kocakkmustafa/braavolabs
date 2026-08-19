import { describe, it, expect } from "vitest";
import {
  runWithTenant,
  runWithoutTenant,
  currentTenantId,
  currentTenantContext,
  TenantContextError,
} from "../tenant-context";

/**
 * BR-P0-004 slice 2 — the explicit "this path intentionally has no tenant"
 * marker.
 *
 * Today a missing tenant context means the Prisma layer passes through
 * unwrapped and RLS policies see a NULL `app.tenant_id` — i.e. fail-OPEN. Some
 * ~18 call sites depend on that (BullMQ workers, cron sweeps, signature-verified
 * webhooks, pre-auth routes, live scripts). Before the fail-closed rule can be
 * turned on (slice 3), every one of those has to say so out loud, so the rule
 * can distinguish "deliberately system-scoped" from "someone forgot".
 *
 * These tests are behavior-preserving by design: inside `runWithoutTenant`,
 * `currentTenantId()` must still be undefined, exactly as today.
 */
describe("tenant-context: explicit system (no-tenant) scope", () => {
  it("runWithoutTenant runs fn and returns its value", () => {
    expect(runWithoutTenant("cron:test", () => 42)).toBe(42);
  });

  it("keeps today's behavior: currentTenantId stays undefined inside", () => {
    const seen = runWithoutTenant("worker:test", () => currentTenantId());
    expect(seen).toBeUndefined();
  });

  it("marks the context as system-scoped, carrying the reason", () => {
    const ctx = runWithoutTenant("webhook:stripe", () => currentTenantContext());
    expect(ctx).toEqual({ kind: "system", reason: "webhook:stripe" });
  });

  it("an UNMARKED path has no context at all — the slice-3 discriminator", () => {
    // This is what the fail-closed rule will reject. It must be distinguishable
    // from an explicitly system-scoped path, not merely "tenantId is undefined"
    // (which is true of BOTH).
    expect(currentTenantContext()).toBeUndefined();
    expect(runWithoutTenant("x", () => currentTenantContext())).not.toBeUndefined();
  });

  it("reports a tenant-scoped context distinctly", () => {
    const ctx = runWithTenant("tenant-a", () => currentTenantContext());
    expect(ctx).toEqual({ kind: "tenant", tenantId: "tenant-a" });
  });

  it("propagates across await boundaries", async () => {
    const seen = await runWithoutTenant("cron:sweep", async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentTenantContext();
    });
    expect(seen).toEqual({ kind: "system", reason: "cron:sweep" });
  });

  it("does not leak after it returns", () => {
    runWithoutTenant("temp", () => currentTenantContext());
    expect(currentTenantContext()).toBeUndefined();
  });

  it("rejects an empty reason — the marker must name the path it excuses", () => {
    expect(() => runWithoutTenant("", () => 1)).toThrow(TenantContextError);
    expect(() => runWithoutTenant("   ", () => 1)).toThrow(/reason/i);
  });

  // --- the direction that MUST work: webhook resolves its tenant, then binds ---
  it("allows runWithTenant INSIDE it — the row-level pattern webhooks need", () => {
    const result = runWithoutTenant("webhook:stripe", () => {
      // handler parses the payload, discovers which tenant the event is for,
      // then does the row-level work properly bound.
      const inner = runWithTenant("tenant-from-payload", () => currentTenantContext());
      return { inner, outer: currentTenantContext() };
    });
    expect(result.inner).toEqual({ kind: "tenant", tenantId: "tenant-from-payload" });
    expect(result.outer).toEqual({ kind: "system", reason: "webhook:stripe" });
  });

  // --- the direction that MUST NOT be allowed: privilege downgrade ---
  it("REFUSES to nest inside a tenant context (would silently drop RLS binding)", () => {
    // Asserting on the dedicated error TYPE, not a message regex: /tenant/i also
    // matches the TypeError "runWithoutTenant is not a function", so a
    // message-only assertion would pass while the feature is still absent.
    expect(() =>
      runWithTenant("tenant-a", () => runWithoutTenant("oops", () => currentTenantId())),
    ).toThrow(TenantContextError);
  });

  it("the refusal survives an await boundary inside the request", async () => {
    await expect(
      runWithTenant("tenant-a", async () => {
        await new Promise((r) => setTimeout(r, 1));
        return runWithoutTenant("oops", () => 1);
      }),
    ).rejects.toThrow(TenantContextError);
  });

  it("keeps concurrent system and tenant contexts independent", async () => {
    const [sys, ten] = await Promise.all([
      runWithoutTenant("worker:a", async () => {
        await new Promise((r) => setTimeout(r, 5));
        return currentTenantContext();
      }),
      runWithTenant("tenant-b", async () => {
        await new Promise((r) => setTimeout(r, 1));
        return currentTenantContext();
      }),
    ]);
    expect(sys).toEqual({ kind: "system", reason: "worker:a" });
    expect(ten).toEqual({ kind: "tenant", tenantId: "tenant-b" });
  });

  it("nested system scopes shadow then restore (worker calling a shared helper)", () => {
    const result = runWithoutTenant("worker:outer", () => {
      const inner = runWithoutTenant("worker:inner", () => currentTenantContext());
      return { inner, afterInner: currentTenantContext() };
    });
    expect(result.inner).toEqual({ kind: "system", reason: "worker:inner" });
    expect(result.afterInner).toEqual({ kind: "system", reason: "worker:outer" });
  });
});

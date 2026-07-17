import { describe, it, expect } from "vitest";
import { runWithTenant, currentTenantId } from "../tenant-context";

/**
 * Unit tests for the AsyncLocalStorage tenant context (RLS-real). The Prisma
 * extension + `tenantTx` that CONSUME this context are validated end-to-end
 * against a real Postgres with a non-superuser role (cross-tenant reads/writes
 * blocked, fail-open with no context) — that can't run in the mocked unit suite,
 * so it's a documented manual/CI-integration check. These tests lock the
 * context primitive the whole mechanism depends on.
 */
describe("tenant-context", () => {
  it("currentTenantId is undefined outside any runWithTenant", () => {
    expect(currentTenantId()).toBeUndefined();
  });

  it("runWithTenant makes the tenantId visible synchronously inside", () => {
    const seen = runWithTenant("tenant-x", () => currentTenantId());
    expect(seen).toBe("tenant-x");
  });

  it("the context propagates across await boundaries (how handlers use it)", async () => {
    const seen = await runWithTenant("tenant-y", async () => {
      await new Promise((r) => setTimeout(r, 1));
      // a prior await must not lose the context — the real request does other
      // awaits before the DB call.
      await Promise.resolve();
      return currentTenantId();
    });
    expect(seen).toBe("tenant-y");
  });

  it("nested runWithTenant shadows then restores the outer tenant", () => {
    const result = runWithTenant("outer", () => {
      const inner = runWithTenant("inner", () => currentTenantId());
      return { inner, afterInner: currentTenantId() };
    });
    expect(result.inner).toBe("inner");
    expect(result.afterInner).toBe("outer");
  });

  it("context does not leak after runWithTenant returns", () => {
    runWithTenant("temp", () => currentTenantId());
    expect(currentTenantId()).toBeUndefined();
  });

  it("two concurrent tenants keep independent contexts (no cross-bleed)", async () => {
    const [a, b] = await Promise.all([
      runWithTenant("A", async () => {
        await new Promise((r) => setTimeout(r, 5));
        return currentTenantId();
      }),
      runWithTenant("B", async () => {
        await new Promise((r) => setTimeout(r, 1));
        return currentTenantId();
      }),
    ]);
    expect(a).toBe("A");
    expect(b).toBe("B");
  });
});

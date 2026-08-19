import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { systemScope } from "../system-scope";
import {
  currentTenantContext,
  currentTenantId,
  runWithTenant,
  TenantContextError,
} from "../../lib/tenant-context";

/**
 * BR-P0-004 slice 2 — Express middleware form of the system-scope marker.
 *
 * Mounted on the routers that legitimately run without a tenant: the
 * signature-verified webhook ingresses (Stripe, IAP notify, voice, generic
 * HMAC) and the pre-auth routes (register/login/refresh/reset, SSO init +
 * callback). It is the mirror image of authMiddleware's `runWithTenant`.
 */
describe("systemScope middleware", () => {
  const req = {} as Request;
  const res = {} as Response;

  it("runs next() inside a system-scoped context carrying the reason", () => {
    let seen: unknown;
    const next = vi.fn(() => {
      seen = currentTenantContext();
    }) as unknown as NextFunction;

    systemScope("webhook:stripe")(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(seen).toEqual({ kind: "system", reason: "webhook:stripe" });
  });

  it("leaves currentTenantId undefined — today's behavior is preserved", () => {
    let seen: unknown = "sentinel";
    systemScope("route:auth")(req, res, (() => {
      seen = currentTenantId();
    }) as unknown as NextFunction);
    expect(seen).toBeUndefined();
  });

  it("does not leak the context to the next request", () => {
    systemScope("webhook:voice")(req, res, (() => {}) as unknown as NextFunction);
    expect(currentTenantContext()).toBeUndefined();
  });

  it("lets a later authMiddleware bind a tenant inside it (mixed router)", () => {
    // /auth is mounted system-scoped, but /auth/verify-email/resend is
    // authMiddleware-gated — authMiddleware's runWithTenant must still work
    // when it runs INSIDE the router-level system scope.
    let seen: unknown;
    systemScope("route:auth")(req, res, (() => {
      runWithTenant("tenant-a", () => {
        seen = currentTenantContext();
      });
    }) as unknown as NextFunction);
    expect(seen).toEqual({ kind: "tenant", tenantId: "tenant-a" });
  });

  it("refuses to run inside an already tenant-scoped request", () => {
    // Ordering error: a system-scope marker mounted AFTER authMiddleware would
    // strip the tenant binding off an authenticated request.
    expect(() =>
      runWithTenant("tenant-a", () =>
        systemScope("oops")(req, res, (() => {}) as unknown as NextFunction),
      ),
    ).toThrow(TenantContextError);
  });

  it("propagates the scope across async handler awaits", async () => {
    let seen: unknown;
    await new Promise<void>((resolve) => {
      systemScope("webhook:iap-apple")(req, res, (async () => {
        await new Promise((r) => setTimeout(r, 1));
        seen = currentTenantContext();
        resolve();
      }) as unknown as NextFunction);
    });
    expect(seen).toEqual({ kind: "system", reason: "webhook:iap-apple" });
  });
});

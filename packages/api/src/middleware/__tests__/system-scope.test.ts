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

/**
 * F-4 regression (found by the BR-P0-004 independent review).
 *
 * A router-level `router.use(systemScope(...))` stays ACTIVE while Express
 * cascades `next()` out of the non-matching router and on to siblings mounted
 * on the same prefix — because the whole cascade happens synchronously inside
 * `storage.run(...)`. A sibling would then inherit a marker it never declared,
 * and once the slice-3 fail-closed rule lands, an unmarked handler there would
 * silently pass the very check the marker exists to enforce.
 *
 * The fix is to mark per ROUTE (route middleware runs only after a path match),
 * never router-wide. These tests pin that difference.
 */
describe("systemScope does not leak to sibling routers", () => {
  it("ROUTER-level marking leaks into a sibling — why we do not use it", async () => {
    const express = (await import("express")).default;
    const http = await import("node:http");
    let seenInSibling: unknown = "unset";

    const app = express();
    const first = express.Router();
    first.use(systemScope("webhook:first")); // the anti-pattern
    first.post("/only-mine", (_q, s) => { s.json({ ok: true }); });
    const sibling = express.Router();
    sibling.post("/other", (_q, s) => {
      seenInSibling = currentTenantContext();
      s.json({ ok: true });
    });
    app.use("/hooks", first);
    app.use("/hooks", sibling);

    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as any).port;
    await fetch(`http://127.0.0.1:${port}/hooks/other`, { method: "POST" });
    await new Promise<void>((r) => server.close(() => r()));

    // Documents the hazard: the sibling declared nothing, yet is scoped.
    expect(seenInSibling).toEqual({ kind: "system", reason: "webhook:first" });
  });

  it("ROUTE-level marking does NOT leak — the shape we actually ship", async () => {
    const express = (await import("express")).default;
    const http = await import("node:http");
    let seenInSibling: unknown = "unset";

    const app = express();
    const first = express.Router();
    first.post("/only-mine", systemScope("webhook:first"), (_q, s) => { s.json({ ok: true }); });
    const sibling = express.Router();
    sibling.post("/other", (_q, s) => {
      seenInSibling = currentTenantContext();
      s.json({ ok: true });
    });
    app.use("/hooks", first);
    app.use("/hooks", sibling);

    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as any).port;
    await fetch(`http://127.0.0.1:${port}/hooks/other`, { method: "POST" });
    await new Promise<void>((r) => server.close(() => r()));

    expect(seenInSibling).toBeUndefined();
  });
});

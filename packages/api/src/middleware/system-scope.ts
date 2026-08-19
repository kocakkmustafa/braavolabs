/**
 * System-scope middleware (BR-P0-004) — the mirror image of authMiddleware's
 * tenant binding.
 *
 * authMiddleware wraps an authenticated request in `runWithTenant(tenantId)`
 * so the Prisma layer can bind `app.tenant_id` for RLS. But several routes
 * legitimately have no tenant to bind:
 *
 *   - signature-verified webhook ingresses (Stripe, Apple/Google IAP notify,
 *     voice providers, the generic per-company HMAC hook) — the caller is a
 *     provider, not a user, and the tenant is only discoverable after the
 *     payload is parsed;
 *   - pre-auth routes (register, login, refresh, password reset, SSO init and
 *     callback) — there is no authenticated tenant yet, by definition.
 *
 * Those are marked with this middleware so the DB layer can tell them apart
 * from a route that simply forgot to establish context. Today both cases
 * behave identically (pass through unwrapped, RLS sees NULL); the marker is
 * what lets slice 3 reject only the second.
 *
 * MOUNT ORDER MATTERS: mount this BEFORE authMiddleware on a mixed router.
 * `runWithoutTenant` refuses to nest inside a tenant context, so a system
 * marker placed after authMiddleware throws rather than silently stripping the
 * request's RLS binding.
 */
import type { Request, Response, NextFunction } from "express";
import { runWithoutTenant } from "../lib/tenant-context";

/**
 * Mark a router or route as deliberately tenant-less.
 *
 * @param reason names the surface, e.g. "webhook:stripe", "route:auth".
 *   It appears in isolation-violation errors so an operator can identify the
 *   path without reading a stack trace.
 */
export function systemScope(reason: string) {
  return function systemScopeMiddleware(_req: Request, _res: Response, next: NextFunction): void {
    runWithoutTenant(reason, next);
  };
}

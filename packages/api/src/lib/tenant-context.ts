/**
 * Per-request tenant context (RLS-real, S-…).
 *
 * Carries the authenticated tenantId through the async call graph via
 * AsyncLocalStorage so the Prisma layer (lib/db.ts) can bind
 * `app.tenant_id` on the SAME connection as each query — the piece that makes
 * PostgreSQL Row-Level Security actually reliable under Prisma's connection
 * pool (a plain `set_config` on a middleware-picked connection does NOT reach
 * the connection a later pooled query runs on).
 *
 * The store is intentionally tiny: only the tenantId. `runWithTenant` is called
 * once by authMiddleware, wrapping the rest of the request; everything the
 * request awaits inherits the context.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface TenantStore {
  tenantId: string;
}

const storage = new AsyncLocalStorage<TenantStore>();

/** Run `fn` (and everything it awaits) with `tenantId` bound to the context. */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return storage.run({ tenantId }, fn);
}

/** The active request's tenantId, or undefined outside an authenticated request
 * (public routes, background jobs, migrations). */
export function currentTenantId(): string | undefined {
  return storage.getStore()?.tenantId;
}

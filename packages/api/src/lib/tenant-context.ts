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
 * The store holds one of two shapes:
 *
 *   { kind: "tenant", tenantId }  — an authenticated request. `runWithTenant`
 *                                   is called once by authMiddleware, wrapping
 *                                   the rest of the request; everything the
 *                                   request awaits inherits the context.
 *
 *   { kind: "system", reason }    — a path that legitimately has no tenant:
 *                                   BullMQ workers, cron sweeps, signature-
 *                                   verified webhooks, pre-auth routes (login,
 *                                   SSO callback), maintenance scripts. Marked
 *                                   with `runWithoutTenant(reason, fn)`.
 *
 * And a third state that is NOT a shape: no store at all — nobody declared
 * anything. `currentTenantId()` is undefined for BOTH "system" and "no store",
 * which is why the marker exists: it is the only way the DB layer can tell
 * "deliberately tenant-less" from "someone forgot to establish context"
 * (BR-P0-004 slice 3 turns the latter into a hard error; today both pass
 * through unwrapped, i.e. fail-open).
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Raised when the tenant context is used in a way that would weaken isolation. */
export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantContextError";
  }
}

export type TenantContext =
  | { kind: "tenant"; tenantId: string }
  | { kind: "system"; reason: string };

const storage = new AsyncLocalStorage<TenantContext>();

/** Run `fn` (and everything it awaits) with `tenantId` bound to the context. */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return storage.run({ kind: "tenant", tenantId }, fn);
}

/**
 * Run `fn` on a path that deliberately has no tenant, saying so out loud.
 *
 * `reason` names the call site (e.g. "worker:pipeline-runs",
 * "webhook:stripe", "route:auth-login") and shows up in the error text when
 * isolation invariants are violated, so an operator can tell which path is
 * involved without reading the stack.
 *
 * Refuses to nest inside a tenant-scoped context. Allowing that would let an
 * authenticated request silently shed its RLS binding — every query underneath
 * would run with `app.tenant_id` NULL and the policies would stop filtering.
 * The inverse nesting IS allowed and is the intended pattern: a webhook runs
 * system-scoped, resolves which tenant the event belongs to, then does the
 * row-level work inside `runWithTenant`.
 */
export function runWithoutTenant<T>(reason: string, fn: () => T): T {
  if (!reason || reason.trim() === "") {
    throw new TenantContextError(
      "runWithoutTenant requires a non-empty reason naming the call site it excuses",
    );
  }
  const current = storage.getStore();
  if (current?.kind === "tenant") {
    throw new TenantContextError(
      `runWithoutTenant("${reason}") was called inside a tenant-scoped context ` +
        `(tenant ${current.tenantId}). Dropping the binding here would run the ` +
        `enclosed queries with no RLS filter. If this path really needs another ` +
        `tenant's data, resolve it explicitly with runWithTenant instead.`,
    );
  }
  return storage.run({ kind: "system", reason }, fn);
}

/** The active request's tenantId, or undefined on system-scoped and unmarked paths. */
export function currentTenantId(): string | undefined {
  const store = storage.getStore();
  return store?.kind === "tenant" ? store.tenantId : undefined;
}

/**
 * The active context, or undefined when nothing was declared at all.
 *
 * Unlike `currentTenantId()`, this distinguishes "explicitly system-scoped"
 * from "unmarked" — the discriminator the fail-closed DB rule needs.
 */
export function currentTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

import { Prisma, PrismaClient } from "@prisma/client";
import { currentTenantContext } from "./tenant-context";
import { resolveTenantBinding } from "./tenant-binding";
import { env } from "../config/env";

/**
 * Interactive-transaction budget for the RLS wrapper (both the auto-wrap and
 * tenantTx). Generous by default so wrapping every op in a transaction does not
 * newly impose Prisma's tight 5s/2s interactive-tx defaults on queries that
 * previously had no app-side ceiling (see env.ts DB_TX_TIMEOUT_MS). Callers may
 * still override per-tenantTx via its `options`.
 */
const TX_OPTIONS = { timeout: env.DB_TX_TIMEOUT_MS, maxWait: env.DB_TX_MAXWAIT_MS } as const;

/**
 * Prisma client with reliable RLS binding (RLS-real).
 *
 * PostgreSQL Row-Level Security reads `current_setting('app.tenant_id')`, which
 * is a PER-CONNECTION session variable. Under Prisma's connection pool the
 * connection that runs `set_config` is NOT guaranteed to be the connection a
 * later query runs on, so a middleware-level `set_config` is unreliable — RLS
 * silently fails open (or, worse, a stale value hides a tenant's own rows).
 *
 * The fix: bind the variable on the SAME connection as the query. Every model
 * operation issued on the exported `prisma` client is transparently wrapped in
 * a batched transaction `[ set_config(app.tenant_id, tenantId, TRUE), <op> ]`
 * (Prisma's official RLS-extension pattern) so the variable and the query share
 * one connection. `TRUE` (is_local) scopes the variable to that transaction, so
 * it dies with the transaction and can never leak to another pooled request —
 * eliminating the stale-value hazard entirely.
 *
 * Multi-statement work (interactive/array transactions) can't be auto-wrapped
 * one-op-at-a-time (that would start a transaction per statement). Those call
 * sites use `tenantTx()` instead, which sets the variable as the first
 * statement of the SAME transaction and hands the caller a `tx` client whose
 * operations run on that connection — so the whole unit is RLS-bound too.
 *
 * When a path is EXPLICITLY system-scoped (`runWithoutTenant` — workers, cron
 * sweeps, signature-verified webhooks, pre-auth routes, maintenance scripts)
 * both paths pass through unwrapped: `current_tenant_id()` is NULL and the
 * policies allow the query.
 *
 * When a path declared NOTHING at all, both paths now THROW (BR-P0-004 slice
 * 3). That case used to be indistinguishable from the one above and was
 * therefore fail-OPEN: a route that forgot to establish context queried with
 * RLS silently disabled. See lib/tenant-binding.ts; TENANT_CONTEXT_FAIL_CLOSED
 * restores the old behavior without a rollback.
 */

const globalForPrisma = globalThis as unknown as { basePrisma?: PrismaClient };

/**
 * The raw, un-extended client. Used INTERNALLY for the transaction wrapping
 * (its `tx` clients are un-extended, so operations inside a `tenantTx` don't
 * re-enter the extension and start a nested transaction). Do NOT import this in
 * feature code — always use `prisma` (auto-RLS) or `tenantTx` (multi-statement).
 */
const base =
  globalForPrisma.basePrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.basePrisma = base;
}

/**
 * The RLS-bound client. Single model operations are auto-wrapped so the tenant
 * variable is set on the same connection. Reads/writes are otherwise identical.
 */
export const prisma = base.$extends({
  name: "rls-tenant-binding",
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        // BR-P0-004 slice 3: an unmarked path is now an ERROR rather than a
        // silent unwrapped query. See lib/tenant-binding.ts.
        const binding = resolveTenantBinding(currentTenantContext(), {
          failClosed: env.TENANT_CONTEXT_FAIL_CLOSED,
          model: model as string,
          operation: operation as string,
        });
        if (binding.mode === "passthrough") return query(args);
        const tenantId = binding.tenantId;
        // Bind the tenant on the SAME connection as the query. An interactive
        // transaction pins one connection; we set_config on it, then RE-DISPATCH
        // the operation on that transaction client (`tx`). NOTE: the array form
        // `$transaction([set_config, query(args)])` does NOT work — `query(args)`
        // executes on the client's own pooled connection, not the transaction's,
        // so the variable never reaches it (verified against real Postgres:
        // it silently failed open). Re-dispatching on `tx` is what actually binds.
        // Prisma reports `model` in PascalCase ("Company", "UserAIConfig"); the
        // client delegate is camelCase ("company", "userAIConfig").
        const delegateName = (model as string).charAt(0).toLowerCase() + (model as string).slice(1);
        return base.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          // `tx` is an un-extended client → this does not re-enter the extension.
          const delegate = (tx as Record<string, any>)[delegateName];
          return delegate[operation as string](args);
        }, TX_OPTIONS);
      },
    },
  },
});

/**
 * Run a multi-statement unit (what used to be `prisma.$transaction(async tx =>
 * …)`) with RLS bound. Sets `app.tenant_id` as the first statement of the
 * transaction, then runs `fn(tx)` on that same connection. The `tx` is an
 * un-extended client, so operations inside never re-wrap. Passes through
 * without set_config on an explicitly system-scoped path, and REJECTS on an
 * unmarked one (BR-P0-004 slice 3).
 */
export function tenantTx<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  // Same fail-closed rule as the auto-wrap above — a multi-statement unit from
  // an unmarked path is exactly as unsafe as a single one.
  //
  // Resolved inside the promise chain deliberately: this function is declared
  // to return Promise<T>, and a SYNCHRONOUS throw would bypass a caller's
  // `.catch()` and surface as an uncaught exception instead of a rejection.
  let binding: ReturnType<typeof resolveTenantBinding>;
  try {
    binding = resolveTenantBinding(currentTenantContext(), {
      failClosed: env.TENANT_CONTEXT_FAIL_CLOSED,
      operation: "tenantTx",
    });
  } catch (err) {
    return Promise.reject(err);
  }
  return base.$transaction(async (tx) => {
    if (binding.mode === "bind") {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${binding.tenantId}, true)`;
    }
    return fn(tx);
    // Caller options win, but default to the generous RLS budget (not Prisma's
    // 5s/2s) so a multi-statement unit isn't newly starved of time.
  }, { ...TX_OPTIONS, ...options });
}

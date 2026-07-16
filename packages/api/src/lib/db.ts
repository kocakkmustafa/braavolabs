import { Prisma, PrismaClient } from "@prisma/client";
import { currentTenantId } from "./tenant-context";

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
 * When there is no tenant context (public routes, background jobs, Prisma
 * migrations) both paths pass through unwrapped: `current_tenant_id()` is NULL
 * and the policies allow the query — exactly today's behavior.
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
        const tenantId = currentTenantId();
        if (!tenantId) return query(args);
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
        });
      },
    },
  },
});

/**
 * Run a multi-statement unit (what used to be `prisma.$transaction(async tx =>
 * …)`) with RLS bound. Sets `app.tenant_id` as the first statement of the
 * transaction, then runs `fn(tx)` on that same connection. The `tx` is an
 * un-extended client, so operations inside never re-wrap. Pass-through (no
 * set_config) when there is no tenant context.
 */
export function tenantTx<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  const tenantId = currentTenantId();
  return base.$transaction(async (tx) => {
    if (tenantId) {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    }
    return fn(tx);
  }, options);
}

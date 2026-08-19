/**
 * The fail-closed tenant rule (BR-P0-004 slice 3).
 *
 * Slice 2 made three states distinguishable at the context layer:
 *
 *   { kind: "tenant" }  an authenticated request
 *   { kind: "system" }  a path that deliberately has no tenant, and said so
 *   undefined           nobody declared anything
 *
 * Until now all three behaved identically at the DB layer: no tenantId meant
 * pass through unwrapped, `current_tenant_id()` came back NULL, and the RLS
 * policies allowed the query. That is fail-OPEN — a route that simply forgot to
 * establish context queried with isolation silently disabled.
 *
 * This is the decision that closes it. Kept pure and separate from db.ts so it
 * can be tested exhaustively without a Postgres.
 */
import { TenantContextError, type TenantContext } from "./tenant-context";

export type TenantBinding =
  | { mode: "bind"; tenantId: string }
  | { mode: "passthrough"; reason: string };

export interface ResolveOpts {
  /**
   * Whether an unmarked context is an error. Wired to
   * TENANT_CONTEXT_FAIL_CLOSED so an operator can relax enforcement without a
   * code change or rollback if an unmarked path is found in production. It
   * relaxes ONLY the unmarked case — tenant requests still bind.
   */
  failClosed: boolean;
  /** Prisma model + operation, used only to make the error actionable. */
  model?: string;
  operation?: string;
}

export function resolveTenantBinding(
  ctx: TenantContext | undefined,
  opts: ResolveOpts,
): TenantBinding {
  if (ctx?.kind === "tenant") return { mode: "bind", tenantId: ctx.tenantId };
  if (ctx?.kind === "system") return { mode: "passthrough", reason: ctx.reason };

  if (!opts.failClosed) {
    return { mode: "passthrough", reason: "unmarked (fail-closed disabled)" };
  }

  const where = opts.model && opts.operation ? `${opts.model}.${opts.operation}` : "a database query";
  throw new TenantContextError(
    `Refusing ${where}: no tenant context was established. ` +
      `Queries from an unmarked path run with app.tenant_id NULL, which disables ` +
      `Row-Level Security for that query. Wrap the call site in runWithTenant(tenantId, fn) ` +
      `if it serves one tenant, or in runWithoutTenant(reason, fn) if it deliberately spans ` +
      `all of them (worker, cron, signature-verified webhook, pre-auth route, maintenance script). ` +
      `Set TENANT_CONTEXT_FAIL_CLOSED=false to temporarily restore the previous fail-open behavior.`,
  );
}

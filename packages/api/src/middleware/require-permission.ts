/**
 * Route-level authorisation (BR-P1-005).
 *
 * `requireRole` has existed in middleware/auth.ts since forever and is applied
 * by ZERO routes, so RBAC has been decorative: any authenticated MEMBER could
 * delete a company, open the billing portal or start a checkout.
 *
 * This is the enforcing half. It is deliberately expressed in terms of ACTIONS
 * rather than role lists at the call site — `requirePermission("company:delete")`
 * says what is being protected, whereas `requireRole("OWNER","ADMIN")` states an
 * answer whose reasoning lives somewhere else and drifts.
 */
import type { RequestHandler } from "express";
import { roleCan, type AppRole, type PrivilegedAction } from "../lib/rbac";
import { logger } from "../lib/logger";
import { recordDenial } from "../lib/audit-writer";

export function requirePermission(action: PrivilegedAction): RequestHandler<any, any, any, any> {
  // Generics are `any` for the same reason as systemScope/authMiddleware: as
  // route middleware, a concretely-typed RequestHandler becomes an inference
  // candidate for Express's route-param generic and collapses req.params.id.
  return function requirePermissionMiddleware(req, res, next): void {
    const auth = (req as { auth?: { role?: string; userId?: string; tenantId?: string } }).auth;
    if (!auth) {
      // Should be unreachable — this always sits behind authMiddleware — but a
      // permission gate that assumes authentication is a permission gate that
      // fails open when someone mounts it in the wrong order.
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (!roleCan(auth.role as AppRole, action)) {
      logger.warn(
        { action, role: auth.role, userId: auth.userId, tenantId: auth.tenantId },
        "authorisation denied",
      );
      // A refusal is evidence. Fire-and-forget so the 403 is not delayed and,
      // more importantly, so a failed write can never fail the request open —
      // if producing the evidence could change the decision, the log would be
      // a bypass.
      if (auth.tenantId && auth.userId) {
        recordDenial({
          tenantId: auth.tenantId,
          actor: auth.userId,
          action,
          // `params.id` alone dropped the identifier on every route that
          // names its param differently — governance:hard-stop uses `:runId`,
          // and "refused to hard-stop WHICH run" is exactly the fact an
          // auditor wants. Falling back to the RIGHTMOST param picks that up
          // today and any future :companyId/:pipelineId without another edit.
          //
          // Rightmost, not first: on a nested route like
          // /companies/:companyId/pipelines/:pipelineId the first value is
          // the PARENT, and an audit row naming the parent when a child was
          // refused is quietly wrong. No gated router is mounted under a
          // param-bearing prefix today and all twelve declare at most one
          // param, so this is identical to `[0]` right now — it is the
          // nesting that has not happened yet that this guards against.
          resourceId:
            (req as { params?: Record<string, unknown> }).params?.id ??
            Object.values((req as { params?: Record<string, unknown> }).params ?? {}).at(-1),
          ip: (req as { ip?: unknown }).ip,
        });
      }
      // Names the action, never the required role: telling a caller "you need
      // OWNER" enumerates the privilege model for them.
      res.status(403).json({ error: `Insufficient permissions for ${action}` });
      return;
    }
    next();
  };
}

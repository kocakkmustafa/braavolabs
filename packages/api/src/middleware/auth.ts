import type { Request, RequestHandler, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { prisma } from "../lib/db";
import { runWithTenant } from "../lib/tenant-context";
import { getCookieAccessToken, csrfOkForCookieAuth } from "../lib/authCookies";

export interface AuthPayload {
  userId: string;
  tenantId: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

/**
 * JWT authentication middleware.
 * Extracts tenant context for tenant-isolated queries and sets the
 * PostgreSQL session variable `app.tenant_id` for RLS policies.
 */
export const authMiddleware: RequestHandler<any, any, any, any> = async function authMiddleware(
  // Generics are deliberately `any`. As ROUTE middleware this sits alongside the
  // real handler, and a concretely-typed RequestHandler becomes an inference
  // candidate for Express's route-parameter generic — which collapses
  // `req.params.slug` on a "/:slug" route from `string` to `string | string[]`
  // in the handler beside it. Same reasoning as middleware/system-scope.ts.
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // Bearer header keeps PRIORITY — mobile clients, API callers, and the
  // current web client are unaffected. Only when there is no Bearer header
  // do we consult the httpOnly access cookie, and only when AUTH_COOKIE_MODE
  // is on (getCookieAccessToken returns null otherwise). This preserves the
  // exact bearer-only behavior while the flag is off.
  const header = req.headers.authorization;
  let token: string | undefined;
  let viaCookie = false;
  if (header?.startsWith("Bearer ")) {
    token = header.slice(7);
  } else {
    const cookieToken = getCookieAccessToken(req);
    if (cookieToken) {
      token = cookieToken;
      viaCookie = true;
    }
  }

  if (!token) {
    res.status(401).json({ error: "Missing or invalid authorization header" });
    return;
  }

  let payload: AuthPayload & { typ?: string };
  try {
    payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] }) as AuthPayload & { typ?: string };
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  // A REFRESH token carries the same {userId,tenantId,role} payload as an access
  // token, distinguished only by typ:"refresh" (see auth.service signRefreshToken).
  // Access tokens have no typ. Reject refresh tokens in the bearer slot — otherwise
  // a captured refresh token (now also sent in /auth/logout request bodies) is a
  // replayable 7-day bearer, defeating the short-access/long-refresh split.
  if (
    !payload || typeof payload !== "object" ||
    typeof payload.userId !== "string" || !payload.userId.trim() ||
    typeof payload.tenantId !== "string" || !payload.tenantId.trim() ||
    payload.typ === "refresh"
  ) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  // CSRF: a cookie-authenticated, state-changing request must present the
  // custom header (SameSite=Strict is the first layer; this is the second).
  // Bearer callers are exempt — see csrfOkForCookieAuth for the full
  // rationale. Placed after token verification so a bad token still reads
  // as 401, not 403.
  if (viaCookie && !csrfOkForCookieAuth(req)) {
    res.status(403).json({ error: "Missing CSRF header for cookie-based auth" });
    return;
  }

  // RLS-real: bind the tenant into the async context. The Prisma layer
  // (lib/db.ts) reads it and sets `app.tenant_id` on the SAME connection as
  // each query (transaction-local), which is the only reliable way to enforce
  // RLS under a connection pool. This REPLACES the old middleware-level
  // `set_config` (which ran on a pool-picked connection that a later query
  // might not use, so RLS failed open — and a stale value could hide a
  // tenant's own rows). Primary isolation remains the app-layer WHERE tenantId;
  // RLS is the enforced DB-level second layer.
  await runWithTenant(payload.tenantId, async () => {
    // Bootstrap the membership lookup inside the verified JWT's tenant scope;
    // querying first would bypass (or fail) the Prisma/RLS tenant binding.
    let user;
    try {
      user = await prisma.user.findFirst({
        where: { id: payload.userId, tenantId: payload.tenantId },
        select: { id: true, tenantId: true, role: true },
      });
    } catch {
      res.status(503).json({ error: "Authentication service temporarily unavailable" });
      return;
    }
    if (!user) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }

    // Deleted/moved users cannot keep their old tenant access. Permission
    // middleware must also see current DB roles, rather than stale JWT roles.
    req.auth = { userId: user.id, tenantId: user.tenantId, role: user.role };
    next();
  });
};

// `requireRole` used to live here. It was exported for a long time and applied
// by ZERO routes, which is precisely how company deletion, billing and
// governance ended up reachable by any authenticated member. Removed rather
// than left in place: a plausible-looking authorisation helper that nothing
// calls is worse than no helper, because it reads as coverage. Use
// middleware/require-permission.ts, which is expressed in terms of actions and
// enforced by lib/rbac.ts.

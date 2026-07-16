import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
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
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
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

  let payload: AuthPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] }) as AuthPayload;
  } catch {
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

  req.auth = payload;

  // RLS-real: bind the tenant into the async context. The Prisma layer
  // (lib/db.ts) reads it and sets `app.tenant_id` on the SAME connection as
  // each query (transaction-local), which is the only reliable way to enforce
  // RLS under a connection pool. This REPLACES the old middleware-level
  // `set_config` (which ran on a pool-picked connection that a later query
  // might not use, so RLS failed open — and a stale value could hide a
  // tenant's own rows). Primary isolation remains the app-layer WHERE tenantId;
  // RLS is the enforced DB-level second layer.
  runWithTenant(payload.tenantId, next);
}

/**
 * Require specific role(s).
 */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (!roles.includes(req.auth.role)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  };
}

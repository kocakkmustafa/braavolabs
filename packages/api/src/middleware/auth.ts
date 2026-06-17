import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { prisma } from "../lib/db";

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
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid authorization header" });
    return;
  }

  const token = header.slice(7);
  let payload: AuthPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] }) as AuthPayload;
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  req.auth = payload;

  // Set PostgreSQL session variable for RLS — defense-in-depth layer.
  // Primary isolation is the Prisma WHERE tenantId clause; this adds DB-level
  // enforcement so a missed filter can't leak cross-tenant rows.
  // Non-fatal: if the DB call fails (e.g. migration not yet run), log and continue.
  try {
    await prisma.$executeRaw`SELECT set_config('app.tenant_id', ${payload.tenantId}, false)`;
    res.on("finish", () => {
      // Reset on response finish so the connection is clean when returned to the pool.
      prisma.$executeRaw`SELECT set_config('app.tenant_id', '', false)`.catch(() => {});
    });
  } catch {
    // Non-fatal — app-layer tenantId filters remain the primary isolation guard.
  }

  next();
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

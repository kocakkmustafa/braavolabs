import type { Request, Response, NextFunction } from "express";
import { redis } from "../lib/redis";

interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyPrefix?: string;
  /**
   * Choose the bucket. Defaults to the tenant, which is right for cost
   * control and WRONG for an individual right: a workspace-wide bucket lets
   * one member exhaust everyone else's ability to exercise it.
   */
  identify?: (req: Request) => string | undefined;
}

/**
 * Redis-based rate limiter middleware.
 */
export function rateLimit(options: RateLimitOptions) {
  const { windowMs, maxRequests, keyPrefix = "rl", identify } = options;
  const windowSec = Math.ceil(windowMs / 1000);

  return async (req: Request, res: Response, next: NextFunction) => {
    const identifier = identify?.(req) ?? req.auth?.tenantId ?? req.ip ?? "anonymous";
    const key = `${keyPrefix}:${identifier}`;

    try {
      const current = await redis.incr(key);
      if (current === 1) {
        await redis.expire(key, windowSec);
      }

      res.setHeader("X-RateLimit-Limit", maxRequests);
      res.setHeader("X-RateLimit-Remaining", Math.max(0, maxRequests - current));

      if (current > maxRequests) {
        res.status(429).json({ error: "Too many requests" });
        return;
      }

      next();
    } catch {
      // If Redis is down, fail CLOSED on every auth-adjacent path so a Redis
      // outage cannot become an open door for credential stuffing. Earlier
      // the check used exact `===` against `"rl:auth"` but the real keys
      // are `rl:auth:login`, `rl:auth:forgot`, `rl:auth:reset`, `rl:register`,
      // `rl:refresh` — none of those matched, so the bucket fell through to
      // `next()` (fail-open). The startsWith form catches the entire family.
      if (
        keyPrefix.startsWith("rl:auth") ||
        keyPrefix === "rl:register" ||
        keyPrefix === "rl:refresh" ||
        // The audit export drains the whole tenant trail a thousand rows at a
        // time. A Redis outage must not silently remove its only ceiling —
        // and unlike a product read, refusing an export for a few minutes
        // costs nothing that matters.
        keyPrefix === "rl:audit-export" ||
        // Same reasoning as audit-export: a Redis outage must not silently
        // remove the only ceiling on a bulk personal-data read.
        keyPrefix === "rl:data-export"
      ) {
        res.status(503).json({ error: "Service temporarily unavailable" });
        return;
      }
      next();
    }
  };
}

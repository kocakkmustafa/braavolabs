import type { Request, Response, NextFunction } from "express";
import { redis } from "../lib/redis";

interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyPrefix?: string;
}

/**
 * Redis-based rate limiter middleware.
 */
export function rateLimit(options: RateLimitOptions) {
  const { windowMs, maxRequests, keyPrefix = "rl" } = options;
  const windowSec = Math.ceil(windowMs / 1000);

  return async (req: Request, res: Response, next: NextFunction) => {
    const identifier = req.auth?.tenantId ?? req.ip ?? "anonymous";
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
      // If Redis is down, fail CLOSED on auth and receipt/store-verification
      // paths. IAP verification and signed notifications consume provider
      // quota even before a business write; outage must not remove that cap.
      // On every auth-adjacent path, a Redis
      // outage cannot become an open door for credential stuffing. Earlier
      // the check used exact `===` against `"rl:auth"` but the real keys
      // are `rl:auth:login`, `rl:auth:forgot`, `rl:auth:reset`, `rl:register`,
      // `rl:refresh` — none of those matched, so the bucket fell through to
      // `next()` (fail-open). The startsWith form catches the entire family.
      if (
        keyPrefix.startsWith("rl:auth") ||
        keyPrefix === "rl:iap" || keyPrefix.startsWith("rl:iap:") ||
        keyPrefix === "rl:register" ||
        keyPrefix === "rl:refresh"
      ) {
        res.status(503).json({ error: "Service temporarily unavailable" });
        return;
      }
      next();
    }
  };
}

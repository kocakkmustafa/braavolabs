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
      // If Redis is down, fail closed on auth endpoints, allow others
      if (keyPrefix === "rl:auth" || keyPrefix === "rl:login" || keyPrefix === "rl:register") {
        res.status(503).json({ error: "Service temporarily unavailable" });
        return;
      }
      next();
    }
  };
}

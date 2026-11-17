import type { Request, Response, NextFunction } from "express";
import { redis } from "../lib/redis";

interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyPrefix?: string;
  /** Varsayılan anahtar tenantId; geçersiz kılınırsa (ör. tenantId:userId) tek üye tüm kiracıyı kilitlemez. */
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
        keyPrefix === "rl:refresh" ||
        // BRA-P0-03a: plan ucu LLM tetikleyebilir; Redis çökünce sınırsız maliyet açılmasın.
        keyPrefix === "rl:jobs:plan" ||
        // BRA-P0-03b: başlatma kota/maliyet harcar; Redis çökünce sınırsız açılmasın.
        keyPrefix === "rl:jobs:start" ||
        // BRA-UX-API-05: sohbet steer kuyruğuna yazar (ajan turuna girer = maliyet); Redis çökünce
        // sınırsız açılmasın. Yan etki: Redis kesintisinde sohbet POST'u 503 verir (GET etkilenmez).
        keyPrefix === "rl:run:chat"
      ) {
        res.status(503).json({ error: "Service temporarily unavailable" });
        return;
      }
      next();
    }
  };
}

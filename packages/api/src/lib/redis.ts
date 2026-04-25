import Redis, { type RedisOptions } from "ioredis";
import { logger } from "./logger";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * Build explicit ioredis options from REDIS_URL.
 *
 * Why not just `new Redis(redisUrl, opts)`? Because ioredis 5.x parses
 * the URL into options *before merging* — fine for the primary client,
 * but `.duplicate()` (used internally by BullMQ for bclient/subscriber)
 * keeps only the constructor options object on retry. If something
 * upstream loses the URL, `redis://localhost:6379` is the silent
 * fallback and `info` / `ping` calls land on a passwordless redis
 * (or an unrelated local one). Result: NOAUTH log spam at ~5/sec in
 * production. Parsing once, here, gives every code path the same set
 * of explicit fields so `.duplicate()` can never drop credentials.
 */
function buildOptions(): RedisOptions {
  const u = new URL(redisUrl);
  return {
    host: u.hostname || "localhost",
    port: parseInt(u.port || "6379", 10),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false,
  };
}

export const redis = new Redis(buildOptions());

redis.on("error", (err) => {
  // ioredis spams `error` events under sustained NOAUTH; emit only a
  // sampled message so a misconfig doesn't drown the log stream.
  logger.error({ err: err.message }, "Redis connection error");
});

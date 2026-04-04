import Redis from "ioredis";
import { logger } from "./logger";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: null, // required by BullMQ
  enableReadyCheck: false,
});

redis.on("error", (err) => {
  logger.error({ err: err.message }, "Redis connection error");
});

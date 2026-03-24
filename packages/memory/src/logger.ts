import pino from "pino";

export const logger = pino({
  name: "memory-engine",
  level: process.env.LOG_LEVEL ?? "debug",
});

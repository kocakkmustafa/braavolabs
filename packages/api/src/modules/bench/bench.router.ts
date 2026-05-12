/**
 * Public bench router. No auth — the leaderboard is publicly
 * readable so the marketing site at /bench can lean on it.
 *
 * Admin endpoint (`POST /run`) is gated by MARKETPLACE_ADMIN_EMAILS
 * + an environment-supplied bench worker token so unattended
 * automation can fire weekly runs from CI without surfacing a
 * password to the world.
 */

import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { prisma } from "../../lib/db";
import { AppError } from "../../middleware/error";
import { runBenchSuite } from "./bench.service";
import crypto from "node:crypto";

export const benchRouter = Router();

benchRouter.get("/", async (_req, res, next) => {
  try {
    const suites = await prisma.benchSuite.findMany({
      where: { isPublic: true },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        maxScorePerTask: true,
      },
    });
    // For each suite, return the latest one run per (provider, model)
    // so the leaderboard reflects only the most recent comparable
    // result. Computed in JS to keep the SQL portable.
    const out = [];
    for (const s of suites) {
      const runs = await prisma.benchRun.findMany({
        where: { suiteId: s.id },
        orderBy: { ranAt: "desc" },
        take: 200,
        select: {
          id: true,
          provider: true,
          model: true,
          scoreNormalised: true,
          costUsd: true,
          durationMs: true,
          ranAt: true,
        },
      });
      const latestByKey = new Map<string, typeof runs[number]>();
      for (const r of runs) {
        const k = `${r.provider}:${r.model}`;
        if (!latestByKey.has(k)) latestByKey.set(k, r);
      }
      const leaderboard = Array.from(latestByKey.values()).sort(
        (a, b) => b.scoreNormalised - a.scoreNormalised,
      );
      out.push({ ...s, leaderboard });
    }
    res.json(out);
  } catch (err) { next(err); }
});

benchRouter.get("/:slug", async (req, res, next) => {
  try {
    const suite = await prisma.benchSuite.findUnique({ where: { slug: req.params.slug } });
    if (!suite || !suite.isPublic) throw new AppError(404, "Suite not found");
    const runs = await prisma.benchRun.findMany({
      where: { suiteId: suite.id },
      orderBy: { ranAt: "desc" },
      take: 200,
    });
    res.json({ suite, runs });
  } catch (err) { next(err); }
});

// Operator-gated run trigger. Two acceptable creds:
//   1. Authenticated request from an email in MARKETPLACE_ADMIN_EMAILS
//   2. `X-Bench-Worker-Token` header matching BENCH_WORKER_TOKEN env
//      (for the weekly CI cron — no session required)
const runSchema = z.object({
  suiteSlug: z.string().min(1).max(120),
  provider: z.enum([
    "ANTHROPIC", "OPENAI", "GOOGLE", "MISTRAL", "GROQ", "OPENROUTER",
    "DEEPSEEK", "KIMI", "QWEN", "OLLAMA", "LMSTUDIO",
  ]),
  model: z.string().min(1).max(200),
  notes: z.string().max(400).optional(),
});

benchRouter.post("/run", async (req, res, next) => {
  try {
    // Worker token path — constant-time compare against env.
    const presented = req.headers["x-bench-worker-token"];
    const expected = process.env.BENCH_WORKER_TOKEN;
    if (typeof presented === "string" && expected && presented.length === expected.length) {
      const ok = crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
      if (ok) {
        const body = runSchema.parse(req.body);
        const result = await runBenchSuite(body);
        res.json(result);
        return;
      }
    }

    // Admin path — fall through to the auth middleware.
    return authMiddleware(req, res, async () => {
      try {
        const adminEmails = (process.env.MARKETPLACE_ADMIN_EMAILS ?? "")
          .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
        const me = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { email: true } });
        if (!me || !adminEmails.includes(me.email.toLowerCase())) {
          throw new AppError(403, "Bench runs are restricted to platform admins");
        }
        const body = runSchema.parse(req.body);
        const result = await runBenchSuite(body);
        res.json(result);
      } catch (err) { next(err); }
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/v1/bench/compare (BRA-P1-05-N1) — ADMIN+ only, fake provider.
 * Mounted BEFORE the public benchRouter. Auth first (401), then permission
 * (403, no body leakage), then rate limit, then validation.
 */
import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middleware/auth";
import { requirePermission } from "../../middleware/require-permission";
import { rateLimit } from "../../middleware/rateLimit";
import { isSafeModelName } from "../company/model-mode-settings";
import { BENCH_COMPARE_SUITE_SLUGS, runBenchCompare } from "./bench-compare";

export const benchCompareRouter = Router();

const PROVIDERS = [
  "ANTHROPIC", "OPENAI", "GOOGLE", "MISTRAL", "GROQ", "OPENROUTER",
  "DEEPSEEK", "KIMI", "QWEN", "OLLAMA", "LMSTUDIO",
] as const;

// TODO(real provider): rateLimit's Redis-outage fail-closed list does not
// include "rl:bench:compare"; once a real (paid) provider is wired in, add it
// there (separate work item, intentionally untouched here).
const limiter =rateLimit({ windowMs: 60 * 60 * 1000, maxRequests: 20, keyPrefix: "rl:bench:compare" });

const bodySchema = z.object({
  suite: z.string().refine((s) => BENCH_COMPARE_SUITE_SLUGS.includes(s), "Unknown bench suite"),
  selections: z.array(z.object({
    provider: z.enum(PROVIDERS),
    model: z.string().refine(isSafeModelName, "Invalid model name"),
  }).strict()).min(2).max(3),
  maxCostUsd: z.number().min(0.001).max(1).optional(),
}).strict().refine(
  (b) => new Set(b.selections.map((s) => `${s.provider}\u0000${s.model}`)).size === b.selections.length,
  "Duplicate selections",
);

// "settings:ai-config" is the closest existing ADMIN+ action (model/provider
// configuration); no new permission or role is introduced.
benchCompareRouter.post("/", authMiddleware, requirePermission("settings:ai-config"), limiter, async (req, res, next) => {
  try {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const out = await runBenchCompare({
      suiteSlug: parsed.data.suite,
      candidates: parsed.data.selections,
      maxCostUsd: parsed.data.maxCostUsd,
    });
    res.set("Cache-Control", "private, no-store");
    res.json(out);
  } catch (err) { next(err); }
});

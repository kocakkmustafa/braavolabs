/**
 * Bench service.
 *
 * `seedBenchSuites()` is idempotent — runs on API startup and on
 * every redeploy. Inserts missing suites and updates the tasks JSON
 * for existing ones so the suite content tracks the code.
 *
 * `runBenchSuite()` executes a single suite × provider × model
 * combination, scores each task with the LLM-as-judge rubric, and
 * persists a BenchRun row.
 *
 * Provider forcing (E2/T5 — D-010): the candidate call now carries an
 * `aiConfigOverride` so the requested provider×model REALLY serves the
 * run. Bench is admin-gated and tenant-less (no BYOK rows to draw from),
 * so keys resolve from the environment: `BENCH_<PROVIDER>_KEY` first,
 * then the system key the API already holds (`ANTHROPIC_API_KEY`,
 * `GROQ_API_KEY`, generic `<PROVIDER>_API_KEY`). A cloud combination
 * without any key is SKIPPED with a report — not an error, and no
 * phantom BenchRun row is written.
 */

import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { env } from "../../config/env";
import { runAgentLoop } from "../agent/claude";
import { LOCAL_PROVIDERS, type AIClientConfig } from "../../services/ai-client";
import { BUILTIN_SUITES, type BenchTask } from "./suites";

export async function seedBenchSuites(): Promise<void> {
  for (const def of BUILTIN_SUITES) {
    await prisma.benchSuite.upsert({
      where: { slug: def.slug },
      create: {
        slug: def.slug,
        name: def.name,
        description: def.description,
        tasks: def.tasks as any,
        maxScorePerTask: def.maxScorePerTask,
        isPublic: def.isPublic,
      },
      update: {
        name: def.name,
        description: def.description,
        tasks: def.tasks as any,
        maxScorePerTask: def.maxScorePerTask,
        isPublic: def.isPublic,
      },
    });
  }
  logger.info({ suites: BUILTIN_SUITES.length }, "Bench suites seeded");
}

export interface RunBenchOptions {
  suiteSlug: string;
  provider:
    | "ANTHROPIC" | "OPENAI" | "GOOGLE" | "MISTRAL" | "GROQ" | "OPENROUTER"
    | "DEEPSEEK" | "KIMI" | "QWEN" | "OLLAMA" | "LMSTUDIO";
  model: string;
  notes?: string;
}

export type BenchProviderName = RunBenchOptions["provider"];

/** Discriminated result: a combination either ran and persisted a
 * BenchRun row, or was skipped (no key for a cloud provider) — skipping
 * is a report, not an error (plan T5 / D-010). */
export type RunBenchResult =
  | { skipped: false; runId: string; score: number; cost: number }
  | { skipped: true; provider: BenchProviderName; model: string; reason: string };

interface TaskScore {
  taskId: string;
  score: number;
  judgeNotes: string;
  /** How tools reached the candidate model on this task's loop (E2/T5).
   * Persisted inside scoresByTask so the BenchRun row records what
   * actually happened on the wire. */
  toolUseMode: string | null;
}

// Judge stays hard-pinned to Claude Sonnet (see rubric call below) — it
// needs an Anthropic key even when the CANDIDATE is another provider.
const JUDGE_MODEL = "claude-sonnet-4-5-20250929";

/** Bench key resolution (E2/T5 — plan §2.5/A3): bench is tenant-less, so
 * keys come from the environment. `BENCH_<PROVIDER>_KEY` wins (lets ops
 * point bench at a dedicated budget), falling back to the system key the
 * API already holds for its own operation. */
function resolveBenchApiKey(provider: BenchProviderName): string | undefined {
  const benchKey = process.env[`BENCH_${provider}_KEY`];
  if (benchKey) return benchKey;
  if (provider === "ANTHROPIC") return env.ANTHROPIC_API_KEY || undefined;
  if (provider === "GROQ") return env.GROQ_API_KEY || undefined;
  return process.env[`${provider}_API_KEY`] || undefined;
}

/**
 * Build the forced AIClientConfig for a bench combination — or null when
 * it cannot run here (cloud provider without any resolvable key). Local
 * providers (OLLAMA / LMSTUDIO) legitimately run keyless; their base URL
 * defaults to localhost and can be overridden with
 * `BENCH_<PROVIDER>_BASE_URL` for a remote inference box.
 */
export function resolveBenchProviderConfig(
  provider: BenchProviderName,
  model: string,
): AIClientConfig | null {
  const apiKey = resolveBenchApiKey(provider);
  if (!apiKey && !LOCAL_PROVIDERS.has(provider)) return null;
  const baseUrl = process.env[`BENCH_${provider}_BASE_URL`]?.trim() || undefined;
  return { provider, model, apiKey: apiKey ?? "", ...(baseUrl ? { baseUrl } : {}) };
}

export async function runBenchSuite(opts: RunBenchOptions): Promise<RunBenchResult> {
  // Pre-flight BOTH key resolutions before spending a single token: a
  // missing judge key would otherwise burn the whole candidate run and
  // then fail at scoring time.
  const candidateConfig = resolveBenchProviderConfig(opts.provider, opts.model);
  if (!candidateConfig) {
    const reason =
      `No API key for ${opts.provider} — set BENCH_${opts.provider}_KEY ` +
      `(or ${opts.provider}_API_KEY) in the API environment`;
    logger.warn(
      { provider: opts.provider, model: opts.model, suite: opts.suiteSlug },
      "Bench combination skipped — no API key for candidate provider",
    );
    return { skipped: true, provider: opts.provider, model: opts.model, reason };
  }
  const judgeConfig = resolveBenchProviderConfig("ANTHROPIC", JUDGE_MODEL);
  if (!judgeConfig) {
    const reason =
      "No Anthropic key for the LLM-as-judge — set BENCH_ANTHROPIC_KEY or ANTHROPIC_API_KEY";
    logger.warn(
      { provider: opts.provider, model: opts.model, suite: opts.suiteSlug },
      "Bench combination skipped — judge (ANTHROPIC) key missing",
    );
    return { skipped: true, provider: opts.provider, model: opts.model, reason };
  }

  const suite = await prisma.benchSuite.findUnique({ where: { slug: opts.suiteSlug } });
  if (!suite) throw new Error(`Bench suite "${opts.suiteSlug}" not found`);

  const tasks = suite.tasks as unknown as BenchTask[];
  const startedAt = Date.now();
  let totalCost = 0;
  const scores: TaskScore[] = [];
  // Actually-used candidate model as reported by the loop (post-hierarchy
  // resolution / provider echo) — persisted on the BenchRun row so the
  // leaderboard reflects what really ran, not what was merely requested.
  let actualModel = opts.model;

  for (const task of tasks) {
    // 1) Have the candidate model answer the task — FORCED to the
    //    requested provider×model via aiConfigOverride (D-010 fix: the
    //    tenant-less runAgentLoop used to land on system Anthropic while
    //    the BenchRun row claimed opts.provider).
    const answer = await runAgentLoop({
      systemPrompt:
        "You are an autonomous AI agent running inside Braavolabs. Answer the user's question precisely. Keep responses focused and under 300 words.",
      userMessage: task.prompt,
      toolNames: [],
      model: opts.model,
      aiConfigOverride: candidateConfig,
    });
    totalCost += answer.totalCostUsd ?? 0;
    if (answer.model) actualModel = answer.model;

    // 2) Have a fixed judge model score the answer against the rubric.
    //    Hard-pinned to Claude Sonnet so the judge stays stable
    //    across runs and we don't have a "judge improvement bias"
    //    where a new candidate model also makes a better judge.
    const judge = await runAgentLoop({
      systemPrompt:
        "You are an impartial grader. Score the candidate's answer against the rubric on a 0..10 integer scale. " +
        "Respond as STRICT JSON: {\"score\": int, \"notes\": string}. " +
        "Penalise hallucination, missing required points, off-topic responses. " +
        "Award full marks only if every rubric criterion is satisfied.",
      userMessage:
        `RUBRIC:\n${task.rubric}\n\nCANDIDATE'S ANSWER:\n${answer.finalContent.slice(0, 4000)}`,
      toolNames: [],
      model: JUDGE_MODEL,
      aiConfigOverride: judgeConfig,
    });
    totalCost += judge.totalCostUsd ?? 0;
    let parsed: { score?: number; notes?: string } | null = null;
    try {
      parsed = JSON.parse(judge.finalContent.trim());
    } catch {
      const match = judge.finalContent.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          /* swallow */
        }
      }
    }
    const score = Math.max(0, Math.min(suite.maxScorePerTask, Math.round(Number(parsed?.score ?? 0))));
    scores.push({
      taskId: task.id,
      score,
      judgeNotes: String(parsed?.notes ?? "").slice(0, 400),
      toolUseMode: answer.toolUseMode ?? null,
    });
  }

  const maxTotal = tasks.length * suite.maxScorePerTask;
  const totalScore = scores.reduce((a, b) => a + b.score, 0);
  const normalised = maxTotal > 0 ? totalScore / maxTotal : 0;

  const run = await prisma.benchRun.create({
    data: {
      suiteId: suite.id,
      // Truthful by construction now: aiConfigOverride forced this exact
      // provider; `model` is the loop-reported actually-used model.
      provider: opts.provider,
      model: actualModel,
      // Per-task toolUseMode travels inside scoresByTask (Json) — no
      // schema change needed to persist it on the record.
      scoresByTask: scores as any,
      scoreNormalised: normalised,
      costUsd: totalCost,
      durationMs: Date.now() - startedAt,
      notes: opts.notes,
    },
  });
  return { skipped: false, runId: run.id, score: normalised, cost: totalCost };
}

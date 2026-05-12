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
 */

import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { runAgentLoop } from "../agent/claude";
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

interface TaskScore {
  taskId: string;
  score: number;
  judgeNotes: string;
}

export async function runBenchSuite(opts: RunBenchOptions): Promise<{ runId: string; score: number; cost: number }> {
  const suite = await prisma.benchSuite.findUnique({ where: { slug: opts.suiteSlug } });
  if (!suite) throw new Error(`Bench suite "${opts.suiteSlug}" not found`);

  const tasks = suite.tasks as unknown as BenchTask[];
  const startedAt = Date.now();
  let totalCost = 0;
  const scores: TaskScore[] = [];

  for (const task of tasks) {
    // 1) Have the candidate model answer the task.
    const answer = await runAgentLoop({
      systemPrompt:
        "You are an autonomous AI agent running inside Braavolabs. Answer the user's question precisely. Keep responses focused and under 300 words.",
      userMessage: task.prompt,
      toolNames: [],
      // The runner picks the model based on the tenant-config layer;
      // for bench we want to force the explicit candidate model.
      // We pass it via `model` so the LLM router picks it up.
      model: opts.model,
    });
    totalCost += answer.totalCostUsd ?? 0;

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
      model: "claude-sonnet-4-5-20250929",
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
    scores.push({ taskId: task.id, score, judgeNotes: String(parsed?.notes ?? "").slice(0, 400) });
  }

  const maxTotal = tasks.length * suite.maxScorePerTask;
  const totalScore = scores.reduce((a, b) => a + b.score, 0);
  const normalised = maxTotal > 0 ? totalScore / maxTotal : 0;

  const run = await prisma.benchRun.create({
    data: {
      suiteId: suite.id,
      provider: opts.provider,
      model: opts.model,
      scoresByTask: scores as any,
      scoreNormalised: normalised,
      costUsd: totalCost,
      durationMs: Date.now() - startedAt,
      notes: opts.notes,
    },
  });
  return { runId: run.id, score: normalised, cost: totalCost };
}

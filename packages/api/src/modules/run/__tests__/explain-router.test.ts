/**
 * POST /runs/:id/explain — D-013 honest provider resolution.
 *
 * The route calls the tenant's own configured LLM to produce a
 * plain-language explanation of a failed run. It used to resolve that
 * config via the raw getTenantAIConfig, which silently fell through to the
 * shared system Anthropic key for ANY tenant without a usable BYOK row —
 * no plan-tier, allowSystemFallback OR counted-trial gate. This suite pins
 * the fix: resolveTenantCompletionLink returns the head of the same D-009
 * chain the run loop dials (services/provider-chain.ts), so an ineligible
 * tenant gets the existing honest 400 ("Add one in Settings...") instead of
 * a silent system-funded completion, a BYOK/trial-eligible tenant is served
 * (trial serves commit the run-based counter), and the two can never drift.
 *
 * Router handlers are exercised directly (same harness as
 * handoff-router.test.ts) — extracted from the Router stack with a mock
 * req/res/next and fully mocked prisma / services.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runFindFirst = vi.hoisted(() => vi.fn());
const runStepFindFirst = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    run: { findFirst: (...a: unknown[]) => runFindFirst(...a) },
    runStep: { findFirst: (...a: unknown[]) => runStepFindFirst(...a) },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
  },
}));

// authMiddleware / rateLimit — pass-through (no JWT, no Redis). We inject
// req.auth ourselves in the test harness, same as handoff-router.test.ts.
vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../middleware/rateLimit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../pipeline/runner", () => ({ enqueueRun: vi.fn() }));

const chatCompletionMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/ai-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/ai-client")>();
  return {
    ...actual,
    chatCompletion: (...a: unknown[]) => chatCompletionMock(...a),
    // getTenantAIConfig itself is untouched by this route anymore — kept
    // real so an accidental regression back to it fails loudly (real impl
    // needs `prisma.userAIConfig`, which isn't mocked here, so it throws).
  };
});

const resolveTenantCompletionLinkMock = vi.hoisted(() => vi.fn());
const commitTrialCompletionMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/provider-chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/provider-chain")>();
  return {
    ...actual,
    resolveTenantCompletionLink: (...a: unknown[]) => resolveTenantCompletionLinkMock(...a),
    commitTrialCompletion: (...a: unknown[]) => commitTrialCompletionMock(...a),
    listTenantProviderLinks: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../../../services/takeover-config", () => ({
  assertKeylessLocalBaseUrl: vi.fn(),
}));

vi.mock("../handoff.service", () => ({
  createHandoff: vi.fn(),
  claimHandoff: vi.fn(),
  cancelOpenHandoffForRun: vi.fn(),
  HandoffClaimError: class HandoffClaimError extends Error {},
}));

const envMock = vi.hoisted(() => ({ NODE_ENV: "development", OFFLINE_MODE: false, CLAUDE_MODEL: "claude-sonnet-4-5" }));
vi.mock("../../../config/env", () => ({ env: envMock }));

import { runRouter } from "../router";

// ── Router handler harness (mirrors handoff-router.test.ts) ──
function getHandler(router: Router, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()],
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void> | void;
}

function mockRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res;
}

async function invoke(handler: (req: any, res: any, next: any) => Promise<void> | void, req: any) {
  const res = mockRes();
  let nextErr: any;
  const next = (err?: any) => { nextErr = err; };
  await handler({ auth: { tenantId: "tenant-1", userId: "user-1", role: "admin" }, params: {}, body: {}, query: {}, ...req }, res, next);
  return { res, nextErr };
}

describe("POST /runs/:id/explain — D-013 provider resolution", () => {
  const handler = getHandler(runRouter, "post", "/:id/explain");

  beforeEach(() => {
    vi.clearAllMocks();
    runFindFirst.mockResolvedValue({ id: "run-1", status: "FAILED", error: "connector timed out after 30s" });
    runStepFindFirst.mockResolvedValue(null);
    activityLogCreate.mockResolvedValue({});
  });

  it("unauthorized / cross-tenant run → 404", async () => {
    runFindFirst.mockResolvedValue(null);
    const { nextErr } = await invoke(handler, { params: { id: "run-x" } });
    expect(nextErr?.statusCode).toBe(404);
  });

  it("run not FAILED → 400, never resolves a provider", async () => {
    runFindFirst.mockResolvedValue({ id: "run-1", status: "RUNNING", error: null });
    const { nextErr } = await invoke(handler, { params: { id: "run-1" } });
    expect(nextErr?.statusCode).toBe(400);
    expect(resolveTenantCompletionLinkMock).not.toHaveBeenCalled();
  });

  it("HONESTY: ineligible tenant (resolveTenantCompletionLink rejects) → 400 actionable error, chatCompletion NEVER called", async () => {
    resolveTenantCompletionLinkMock.mockRejectedValue(
      new Error("No AI provider configured. Please add an API key in Settings → AI Provider."),
    );

    const { nextErr } = await invoke(handler, { params: { id: "run-1" } });

    expect(nextErr?.statusCode).toBe(400);
    expect(nextErr?.message).toMatch(/add one in settings/i);
    // The whole point of D-013: no completion call happens on the honest
    // path, so no system credit is ever at risk.
    expect(chatCompletionMock).not.toHaveBeenCalled();
    expect(commitTrialCompletionMock).not.toHaveBeenCalled();
  });

  it("eligible/BYOK tenant: resolved config is used for the completion, response unchanged", async () => {
    resolveTenantCompletionLinkMock.mockResolvedValue({
      provider: "DEEPSEEK",
      source: "byok-default",
      config: { provider: "DEEPSEEK", model: "deepseek-chat", apiKey: "sk-ds" },
    });
    chatCompletionMock.mockResolvedValue({
      content: JSON.stringify({ explanation: "The connector timed out.", suggestedFix: "Retry the run." }),
      inputTokens: 5,
      outputTokens: 8,
      provider: "DEEPSEEK",
      model: "deepseek-chat",
    });

    const { res, nextErr } = await invoke(handler, { params: { id: "run-1" } });

    expect(nextErr).toBeUndefined();
    expect(resolveTenantCompletionLinkMock).toHaveBeenCalledWith("tenant-1");
    expect(chatCompletionMock).toHaveBeenCalledWith(
      { provider: "DEEPSEEK", model: "deepseek-chat", apiKey: "sk-ds" },
      expect.any(String),
      expect.any(Array),
      512,
    );
    expect(res.body).toMatchObject({
      explanation: "The connector timed out.",
      suggestedFix: "Retry the run.",
      provider: "DEEPSEEK",
      generatedByAi: true,
    });
    // BYOK source → the trial counter is not committed.
    expect(commitTrialCompletionMock).toHaveBeenCalledWith("tenant-1", "byok-default");
  });

  it("HONESTY: BYOK-less FREE tenant served by the counted trial → the run-based counter is committed after success", async () => {
    resolveTenantCompletionLinkMock.mockResolvedValue({
      provider: "GROQ",
      source: "trial",
      config: { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "gsk-trial" },
    });
    chatCompletionMock.mockResolvedValue({
      content: JSON.stringify({ explanation: "The connector timed out.", suggestedFix: "Retry the run." }),
      inputTokens: 5,
      outputTokens: 8,
      provider: "GROQ",
      model: "llama-3.3-70b-versatile",
    });

    const { nextErr } = await invoke(handler, { params: { id: "run-1" } });

    expect(nextErr).toBeUndefined();
    expect(commitTrialCompletionMock).toHaveBeenCalledWith("tenant-1", "trial");
  });
});

/**
 * POST /pipelines/from-natural-language — D-013 honest provider resolution.
 *
 * This endpoint dials an LLM to turn a plain-language description into a
 * pipeline config. It USED to construct the Anthropic SDK directly from
 * `env.ANTHROPIC_API_KEY` — i.e. it spent the shared SYSTEM Anthropic wallet
 * for EVERY tenant, unconditionally, with no plan-tier, allowSystemFallback
 * or counted-trial gate (and even for tenants who had configured their own
 * BYOK key). That is the single-completion sibling of D-009/D-013.
 *
 * This suite pins the fix: the route resolves through
 * resolveTenantCompletionLink (the head of the same D-009 chain the run loop
 * dials), so an ineligible tenant gets an honest 400 instead of a silent
 * system-funded completion, a BYOK/trial-eligible tenant is served on the
 * resolved config, and a trial-served build commits the run-based counter
 * (consume-on-serve; a thrown completion refunds it).
 *
 * Router handlers are exercised directly (same zero-network harness as
 * pipeline-router-schedule.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const companyFindFirst = vi.hoisted(() => vi.fn());
const pipelineCreate = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    company: { findFirst: (...a: unknown[]) => companyFindFirst(...a) },
    pipeline: { create: (...a: unknown[]) => pipelineCreate(...a) },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
  },
}));

vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../middleware/rateLimit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../runner", () => ({
  enqueueRun: vi.fn(),
  registerSchedule: vi.fn(),
  removeSchedule: vi.fn(),
}));
vi.mock("../../../lib/queue", () => ({
  scheduleQueue: { getJobSchedulers: vi.fn().mockResolvedValue([]) },
}));
vi.mock("../../billing/metering", () => ({ claimQuota: vi.fn() }));
vi.mock("../../../config/env", () => ({ env: { CLAUDE_MODEL: "claude-x", ANTHROPIC_API_KEY: "sk-ant-system-key" } }));
vi.mock("../../../lib/modelPricing", () => ({ estimatePipelineCostUsd: vi.fn() }));

const chatCompletionMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/ai-client", () => ({
  getTenantAIConfig: vi.fn(),
  chatCompletion: (...a: unknown[]) => chatCompletionMock(...a),
}));

const resolveTenantCompletionLinkMock = vi.hoisted(() => vi.fn());
const commitTrialCompletionMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/provider-chain", () => ({
  resolveTenantCompletionLink: (...a: unknown[]) => resolveTenantCompletionLinkMock(...a),
  commitTrialCompletion: (...a: unknown[]) => commitTrialCompletionMock(...a),
}));

import { pipelineRouter } from "../router";

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

async function invoke(handler: any, req: any) {
  const res = mockRes();
  let nextErr: any = undefined;
  const next = (err?: any) => { nextErr = err; };
  await handler(
    { auth: { tenantId: "tenant-1", userId: "user-1", role: "admin" }, params: {}, body: {}, query: {}, ...req },
    res,
    next,
  );
  return { res, nextErr };
}

const NL_CONFIG = JSON.stringify({
  name: "Weekly digest",
  trigger: "MANUAL",
  steps: [{ name: "gather", agentRole: "researcher", order: 0 }],
});

describe("POST /pipelines/from-natural-language — D-013 provider resolution", () => {
  const handler = getHandler(pipelineRouter, "post", "/from-natural-language");
  const body = { companyId: "co-1", description: "a weekly research digest for the team" };

  beforeEach(() => {
    vi.clearAllMocks();
    companyFindFirst.mockResolvedValue({ id: "co-1", tenantId: "tenant-1", agents: [{ name: "R", role: "researcher" }] });
    pipelineCreate.mockResolvedValue({ id: "pl-1", trigger: "MANUAL", enabled: true, schedule: null, steps: [] });
    activityLogCreate.mockResolvedValue({});
  });

  it("HONESTY: ineligible tenant (resolveTenantCompletionLink rejects) → 400, chatCompletion NEVER called (no system spend)", async () => {
    resolveTenantCompletionLinkMock.mockRejectedValue(
      new Error("No AI provider configured. Please add an API key in Settings → AI Provider."),
    );

    const { nextErr } = await invoke(handler, { body });

    expect(nextErr?.statusCode).toBe(400);
    expect(nextErr?.message).toMatch(/add one in settings/i);
    // The whole point: no completion happens on the honest path, so the
    // shared system Anthropic wallet is never at risk for a keyless tenant.
    expect(chatCompletionMock).not.toHaveBeenCalled();
    expect(commitTrialCompletionMock).not.toHaveBeenCalled();
    expect(pipelineCreate).not.toHaveBeenCalled();
  });

  it("eligible/BYOK tenant: resolved config is threaded into chatCompletion, pipeline created", async () => {
    resolveTenantCompletionLinkMock.mockResolvedValue({
      provider: "DEEPSEEK",
      source: "byok-default",
      config: { provider: "DEEPSEEK", model: "deepseek-chat", apiKey: "sk-ds" },
    });
    chatCompletionMock.mockResolvedValue({
      content: NL_CONFIG,
      inputTokens: 12,
      outputTokens: 30,
      provider: "DEEPSEEK",
      model: "deepseek-chat",
    });

    const { res, nextErr } = await invoke(handler, { body });

    expect(nextErr).toBeUndefined();
    expect(resolveTenantCompletionLinkMock).toHaveBeenCalledWith("tenant-1");
    expect(chatCompletionMock).toHaveBeenCalledWith(
      { provider: "DEEPSEEK", model: "deepseek-chat", apiKey: "sk-ds" },
      expect.any(String),
      expect.any(Array),
      1024,
    );
    expect(res.statusCode).toBe(201);
    // The response echoes the model that actually served — not env.CLAUDE_MODEL.
    expect(res.body).toMatchObject({ aiModel: "deepseek-chat" });
    // BYOK source → commit is a no-op but still called with the honest source.
    expect(commitTrialCompletionMock).toHaveBeenCalledWith("tenant-1", "byok-default");
  });

  it("HONESTY: BYOK-less FREE tenant served by the counted trial → the run-based counter is committed after success", async () => {
    resolveTenantCompletionLinkMock.mockResolvedValue({
      provider: "GROQ",
      source: "trial",
      config: { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "gsk-trial" },
    });
    chatCompletionMock.mockResolvedValue({
      content: NL_CONFIG,
      inputTokens: 12,
      outputTokens: 30,
      provider: "GROQ",
      model: "llama-3.3-70b-versatile",
    });

    const { nextErr } = await invoke(handler, { body });

    expect(nextErr).toBeUndefined();
    expect(commitTrialCompletionMock).toHaveBeenCalledWith("tenant-1", "trial");
    // Ordering: the completion runs BEFORE the counter commit (consume-on-serve).
    expect(chatCompletionMock.mock.invocationCallOrder[0]).toBeLessThan(
      commitTrialCompletionMock.mock.invocationCallOrder[0],
    );
  });

  it("REFUND: provider call throws → 502 and the trial counter is NEVER committed", async () => {
    resolveTenantCompletionLinkMock.mockResolvedValue({
      provider: "GROQ",
      source: "trial",
      config: { provider: "GROQ", model: "llama-3.3-70b-versatile", apiKey: "gsk-trial" },
    });
    chatCompletionMock.mockRejectedValue(new Error("GROQ API error 503: overloaded"));

    const { nextErr } = await invoke(handler, { body });

    expect(nextErr?.statusCode).toBe(502);
    expect(commitTrialCompletionMock).not.toHaveBeenCalled();
    expect(pipelineCreate).not.toHaveBeenCalled();
  });
});

/**
 * E5/T2 — POST /pipelines/:id/run rejects an empty-steps pipeline with a
 * visible 422 BEFORE claiming quota (adversarial B5 / findings E5-IMP-05).
 *
 * Asserts: steps=[] → 422, NO Run created, and claimQuota NOT called (quota is
 * not consumed by a run that can never execute). A non-empty pipeline still
 * reaches claimQuota (control).
 * Native104: PAUSED/ARCHIVED companies reject new manual runs before any
 * side effect; DRAFT/ACTIVE and disabled automatic triggers remain runnable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const pipelineFindUnique = vi.hoisted(() => vi.fn());
const runCreate = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());
const claimQuotaMock = vi.hoisted(() => vi.fn());
const enqueueRunMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    pipeline: { findUnique: (...a: unknown[]) => pipelineFindUnique(...a) },
    run: { create: (...a: unknown[]) => runCreate(...a) },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
  },
}));
vi.mock("../runner", () => ({
  enqueueRun: (...a: unknown[]) => enqueueRunMock(...a),
  registerSchedule: vi.fn(),
  removeSchedule: vi.fn(),
}));
vi.mock("../../../lib/queue", () => ({
  runQueue: { getJobSchedulers: vi.fn().mockResolvedValue([]) },
  scheduleQueue: { getJobSchedulers: vi.fn().mockResolvedValue([]) },
}));
vi.mock("../../billing/metering", () => ({ claimQuota: (...a: unknown[]) => claimQuotaMock(...a) }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class {} }));
vi.mock("../../../config/env", () => ({ env: { CLAUDE_MODEL: "claude-x" } }));
vi.mock("../../../services/ai-client", () => ({ getTenantAIConfig: vi.fn() }));
vi.mock("../../../lib/modelPricing", () => ({ estimatePipelineCostUsd: vi.fn() }));
vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../middleware/rateLimit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
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

const handler = getHandler(pipelineRouter, "post", "/:id/run");
const runnableSteps = [{ name: "s1", agentRole: "imported_operator", order: 0 }];

function expectNoRunSideEffects() {
  expect(claimQuotaMock).not.toHaveBeenCalled();
  expect(runCreate).not.toHaveBeenCalled();
  expect(activityLogCreate).not.toHaveBeenCalled();
  expect(enqueueRunMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  activityLogCreate.mockResolvedValue({});
  runCreate.mockResolvedValue({ id: "run-1" });
  enqueueRunMock.mockResolvedValue("job-1");
  claimQuotaMock.mockResolvedValue({ claimed: true, value: 1, limit: 100 });
});

describe("POST /:id/run — empty-steps guard", () => {
  it("steps=[] → 422, no Run, claimQuota NOT called", async () => {
    pipelineFindUnique.mockResolvedValue({
      id: "pipe-1",
      steps: [],
      company: { tenantId: "tenant-1", status: "ACTIVE" },
    });

    const { res, nextErr } = await invoke(handler, { params: { id: "pipe-1" } });

    expect(res.statusCode).toBe(200); // handler threw → next(err), res untouched
    expect(nextErr).toBeTruthy();
    expect(nextErr.statusCode).toBe(422);
    expectNoRunSideEffects();
  });

  it("non-empty steps → proceeds to claimQuota and creates a Run (control)", async () => {
    pipelineFindUnique.mockResolvedValue({
      id: "pipe-1",
      steps: [{ name: "s1", agentRole: "imported_operator", order: 0 }],
      company: { tenantId: "tenant-1", status: "ACTIVE" },
    });

    const { res, nextErr } = await invoke(handler, { params: { id: "pipe-1" } });

    expect(nextErr).toBeUndefined();
    expect(claimQuotaMock).toHaveBeenCalledOnce();
    expect(runCreate).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(201);
  });
});

describe("POST /:id/run — company lifecycle guard", () => {
  it.each([
    { status: "PAUSED", steps: runnableSteps },
    { status: "ARCHIVED", steps: runnableSteps },
    { status: "PAUSED", steps: [] },
    { status: "ARCHIVED", steps: [] },
  ])("$status with $steps → 409 before empty-step validation or side effects", async ({ status, steps }) => {
    pipelineFindUnique.mockResolvedValue({
      id: "pipe-1",
      steps,
      enabled: true,
      company: { tenantId: "tenant-1", status },
    });

    const { res, nextErr } = await invoke(handler, { params: { id: "pipe-1" } });

    expect(nextErr?.statusCode).toBe(409);
    expect(nextErr?.message).toBe("New runs are unavailable while the company is paused or archived.");
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeUndefined();
    expectNoRunSideEffects();
  });

  it.each(["PAUSED", "ARCHIVED"])("another tenant's %s company → 404 before lifecycle disclosure", async (status) => {
    pipelineFindUnique.mockResolvedValue({
      id: "pipe-1",
      steps: [],
      company: { tenantId: "tenant-other", status },
    });

    const { res, nextErr } = await invoke(handler, { params: { id: "pipe-1" } });

    expect(nextErr?.statusCode).toBe(404);
    expect(nextErr?.message).toBe("Pipeline not found");
    expect(res.body).toBeUndefined();
    expectNoRunSideEffects();
  });

  it.each([
    { label: "missing pipeline", pipeline: null },
    { label: "missing company", pipeline: { id: "pipe-1", steps: runnableSteps, company: null } },
  ])("$label → 404 without side effects", async ({ pipeline }) => {
    pipelineFindUnique.mockResolvedValue(pipeline);

    const { nextErr } = await invoke(handler, { params: { id: "pipe-1" } });

    expect(nextErr?.statusCode).toBe(404);
    expectNoRunSideEffects();
  });

  it.each([
    { status: "ACTIVE", enabled: true },
    { status: "DRAFT", enabled: true },
    { status: "ACTIVE", enabled: false },
    { status: "DRAFT", enabled: false },
  ])("$status / enabled=$enabled preserves manual Run", async ({ status, enabled }) => {
    pipelineFindUnique.mockResolvedValue({
      id: "pipe-1",
      steps: runnableSteps,
      enabled,
      company: { tenantId: "tenant-1", status },
    });

    const { res, nextErr } = await invoke(handler, {
      params: { id: "pipe-1" }, body: { input: { brief: "fixture-only" } },
    });

    expect(nextErr).toBeUndefined();
    expect(claimQuotaMock).toHaveBeenCalledExactlyOnceWith("tenant-1", "runs");
    expect(runCreate).toHaveBeenCalledExactlyOnceWith({
      data: { pipelineId: "pipe-1", status: "PENDING", trigger: "manual", input: { brief: "fixture-only" } },
    });
    expect(activityLogCreate).toHaveBeenCalledOnce();
    expect(enqueueRunMock).toHaveBeenCalledExactlyOnceWith("run-1");
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ id: "run-1", jobId: "job-1" });
  });
});

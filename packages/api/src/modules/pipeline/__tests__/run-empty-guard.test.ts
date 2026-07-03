/**
 * E5/T2 — POST /pipelines/:id/run rejects an empty-steps pipeline with a
 * visible 422 BEFORE claiming quota (adversarial B5 / findings E5-IMP-05).
 *
 * Asserts: steps=[] → 422, NO Run created, and claimQuota NOT called (quota is
 * not consumed by a run that can never execute). A non-empty pipeline still
 * reaches claimQuota (control).
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
      company: { tenantId: "tenant-1" },
    });

    const { res, nextErr } = await invoke(handler, { params: { id: "pipe-1" } });

    expect(res.statusCode).toBe(200); // handler threw → next(err), res untouched
    expect(nextErr).toBeTruthy();
    expect(nextErr.statusCode).toBe(422);
    expect(claimQuotaMock).not.toHaveBeenCalled();
    expect(runCreate).not.toHaveBeenCalled();
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });

  it("non-empty steps → proceeds to claimQuota and creates a Run (control)", async () => {
    pipelineFindUnique.mockResolvedValue({
      id: "pipe-1",
      steps: [{ name: "s1", agentRole: "imported_operator", order: 0 }],
      company: { tenantId: "tenant-1" },
    });

    const { res, nextErr } = await invoke(handler, { params: { id: "pipe-1" } });

    expect(nextErr).toBeUndefined();
    expect(claimQuotaMock).toHaveBeenCalledOnce();
    expect(runCreate).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(201);
  });
});

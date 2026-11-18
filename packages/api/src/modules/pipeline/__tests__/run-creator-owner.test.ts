/**
 * BRA-P0-02c-1 — POST /pipelines/:id/run writes the run owner
 * (tenantId = Pipeline → Company.tenantId, workspaceId = Pipeline.companyId)
 * and an optional, validated job budget (runs.job_budget).
 *
 * Webhook and scheduled creators are covered in webhook/__tests__/router.test.ts
 * and pipeline/__tests__/scheduled-tick.test.ts.
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

async function invoke(req: any) {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  let nextErr: any;
  await handler(
    { auth: { tenantId: "tenant-1", userId: "user-1", role: "admin" }, params: { id: "pipe-1" }, body: {}, query: {}, ...req },
    res,
    (err?: any) => { nextErr = err; },
  );
  return { res, nextErr };
}

const handler = getHandler(pipelineRouter, "post", "/:id/run");
const PIPE = {
  id: "pipe-1",
  companyId: "co-1",
  steps: [{ name: "s1", agentRole: "imported_operator", order: 0 }],
  company: { id: "co-1", tenantId: "tenant-1", status: "ACTIVE" },
};

beforeEach(() => {
  vi.clearAllMocks();
  pipelineFindUnique.mockResolvedValue(PIPE);
  activityLogCreate.mockResolvedValue({});
  runCreate.mockResolvedValue({ id: "run-1" });
  enqueueRunMock.mockResolvedValue("job-1");
  claimQuotaMock.mockResolvedValue({ claimed: true, value: 1, limit: 100 });
});

describe("POST /pipelines/:id/run — run owner (BRA-P0-02c-1)", () => {
  it("writes tenantId (Company.tenantId) and workspaceId (Pipeline.companyId); no budget key when absent", async () => {
    const { res, nextErr } = await invoke({});
    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(201);
    const data = runCreate.mock.calls[0]![0].data;
    expect(data).toMatchObject({ pipelineId: "pipe-1", tenantId: "tenant-1", workspaceId: "co-1", trigger: "manual", status: "PENDING" });
    expect(data).not.toHaveProperty("jobBudget"); // NULL column = no job-level limit
    expect(data).not.toHaveProperty("idempotencyKey");
  });

  it("cross-tenant pipeline → 404, no quota claim, no run", async () => {
    pipelineFindUnique.mockResolvedValue({ ...PIPE, company: { ...PIPE.company, tenantId: "tenant-2" } });
    const { nextErr } = await invoke({});
    expect(nextErr?.statusCode).toBe(404);
    expect(claimQuotaMock).not.toHaveBeenCalled();
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("the owner is never taken from the request body", async () => {
    await invoke({ body: { input: {}, tenantId: "tenant-evil", workspaceId: "co-evil" } });
    const data = runCreate.mock.calls[0]![0].data;
    expect(data.tenantId).toBe("tenant-1");
    expect(data.workspaceId).toBe("co-1");
  });
});

describe("POST /pipelines/:id/run — body.budget (BRA-P0-02c-1)", () => {
  it("valid budget is stored in jobBudget (schema-normalised, warnRatio defaulted)", async () => {
    await invoke({ body: { budget: { maxUsd: 5, maxSteps: 10 } } });
    expect(runCreate.mock.calls[0]![0].data.jobBudget).toEqual({ maxUsd: 5, maxSteps: 10, warnRatio: 0.8 });
  });

  it("budget null behaves like absent", async () => {
    await invoke({ body: { budget: null } });
    expect(runCreate.mock.calls[0]![0].data).not.toHaveProperty("jobBudget");
  });

  it.each([
    ["unknown key (strict)", { maxUsd: 1, bogus: 1 }],
    ["negative limit", { maxUsd: -1 }],
    ["non-integer steps", { maxSteps: 1.5 }],
    ["wrong type", { maxUsd: "5" }],
    ["warnRatio out of range", { warnRatio: 1 }],
    ["not an object", "5"],
    ["array", []],
  ])("invalid budget (%s) → 400, no quota claim, no run, no enqueue", async (_n, budget) => {
    const { nextErr } = await invoke({ body: { budget } });
    expect(nextErr?.statusCode).toBe(400);
    expect(claimQuotaMock).not.toHaveBeenCalled();
    expect(runCreate).not.toHaveBeenCalled();
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });
});

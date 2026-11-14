/**
 * BRA-P1-04b — POST /pipelines/:id/schedule/pause|resume.
 * Same zero-network harness as pipeline-router-schedule.test.ts.
 * Disabled-pipeline-no-tick is proven in scheduled-tick.test.ts
 * ("disabled pipeline → no run created").
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const pipelineFindUnique = vi.hoisted(() => vi.fn());
const pipelineUpdate = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    company: { findFirst: vi.fn() },
    pipeline: {
      findUnique: (...a: unknown[]) => pipelineFindUnique(...a),
      update: (...a: unknown[]) => pipelineUpdate(...a),
    },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
  },
}));

const authMw = vi.hoisted(() => vi.fn());
vi.mock("../../../middleware/auth", () => ({ authMiddleware: authMw }));
vi.mock("../../../middleware/rateLimit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const registerScheduleMock = vi.hoisted(() => vi.fn());
const removeScheduleMock = vi.hoisted(() => vi.fn());
vi.mock("../runner", () => ({
  enqueueRun: vi.fn(),
  registerSchedule: (...a: unknown[]) => registerScheduleMock(...a),
  removeSchedule: (...a: unknown[]) => removeScheduleMock(...a),
}));
vi.mock("../../../lib/queue", () => ({
  runQueue: { getJobSchedulers: vi.fn().mockResolvedValue([]) },
  scheduleQueue: { getJobSchedulers: vi.fn().mockResolvedValue([]) },
}));
vi.mock("../../billing/metering", () => ({ claimQuota: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class {} }));
vi.mock("../../../config/env", () => ({ env: { CLAUDE_MODEL: "claude-x" } }));
vi.mock("../../../services/ai-client", () => ({ getTenantAIConfig: vi.fn() }));
vi.mock("../../../lib/modelPricing", () => ({ estimatePipelineCostUsd: vi.fn() }));

import { pipelineRouter } from "../router";

function getHandler(router: Router, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods.post,
  );
  if (!layer) throw new Error(`No route POST ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void>;
}

async function invoke(handler: any, req: any = {}) {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
  };
  let nextErr: any;
  await handler(
    { auth: { tenantId: "tenant-1", userId: "user-1", role: "ADMIN" }, params: { id: "pipe-1" }, body: {}, query: {}, ...req },
    res,
    (e?: any) => { nextErr = e; },
  );
  return { res, nextErr };
}

const base = {
  id: "pipe-1",
  trigger: "SCHEDULED",
  schedule: "0 9 * * *",
  enabled: true,
  company: { tenantId: "tenant-1" },
};

const pause = getHandler(pipelineRouter, "/:id/schedule/pause");
const resume = getHandler(pipelineRouter, "/:id/schedule/resume");

beforeEach(() => {
  vi.clearAllMocks();
  pipelineFindUnique.mockResolvedValue(base);
  pipelineUpdate.mockImplementation(async ({ data }: any) => ({ ...base, ...data, company: undefined }));
  activityLogCreate.mockResolvedValue({});
  registerScheduleMock.mockResolvedValue(undefined);
  removeScheduleMock.mockResolvedValue(undefined);
});

describe("schedule pause", () => {
  it("sets enabled=false, removes scheduler, logs activity", async () => {
    const { res, nextErr } = await invoke(pause);
    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(pipelineUpdate).toHaveBeenCalledWith({ where: { id: "pipe-1" }, data: { enabled: false } });
    expect(removeScheduleMock).toHaveBeenCalledWith("pipe-1");
    expect(registerScheduleMock).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ id: "pipe-1", enabled: false });
    expect(activityLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: "tenant-1", actor: "user-1", action: "pipeline.schedule.pause", resourceId: "pipe-1",
        }),
      }),
    );
  });

  it("is idempotent: pausing an already paused pipeline → 200, same state", async () => {
    pipelineFindUnique.mockResolvedValue({ ...base, enabled: false });
    const { res, nextErr } = await invoke(pause);
    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ enabled: false });
  });

  it("foreign tenant → 404, nothing mutated", async () => {
    pipelineFindUnique.mockResolvedValue({ ...base, company: { tenantId: "tenant-2" } });
    const { nextErr } = await invoke(pause);
    expect(nextErr.status ?? nextErr.statusCode).toBe(404);
    expect(pipelineUpdate).not.toHaveBeenCalled();
    expect(removeScheduleMock).not.toHaveBeenCalled();
  });

  it("missing pipeline → 404", async () => {
    pipelineFindUnique.mockResolvedValue(null);
    const { nextErr } = await invoke(pause);
    expect(nextErr.status ?? nextErr.statusCode).toBe(404);
  });
});

describe("schedule resume", () => {
  it("sets enabled=true, registers scheduler, logs activity", async () => {
    pipelineFindUnique.mockResolvedValue({ ...base, enabled: false });
    const { res, nextErr } = await invoke(resume);
    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(pipelineUpdate).toHaveBeenCalledWith({ where: { id: "pipe-1" }, data: { enabled: true } });
    expect(registerScheduleMock).toHaveBeenCalledWith(expect.objectContaining({ id: "pipe-1", schedule: "0 9 * * *" }));
    expect(removeScheduleMock).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ enabled: true });
    expect(activityLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "pipeline.schedule.resume" }) }),
    );
  });

  it("is idempotent: resuming an enabled pipeline → 200", async () => {
    const { res, nextErr } = await invoke(resume);
    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ enabled: true });
  });

  it("pipeline without a registered schedule → 409, nothing mutated", async () => {
    for (const p of [
      { ...base, schedule: null },
      { ...base, trigger: "MANUAL" },
      { ...base, schedule: "not-a-cron" },
    ]) {
      pipelineFindUnique.mockResolvedValue(p);
      const { nextErr } = await invoke(resume);
      expect(nextErr.status ?? nextErr.statusCode).toBe(409);
    }
    expect(pipelineUpdate).not.toHaveBeenCalled();
    expect(registerScheduleMock).not.toHaveBeenCalled();
  });

  it("foreign tenant → 404", async () => {
    pipelineFindUnique.mockResolvedValue({ ...base, company: { tenantId: "tenant-2" } });
    const { nextErr } = await invoke(resume);
    expect(nextErr.status ?? nextErr.statusCode).toBe(404);
    expect(registerScheduleMock).not.toHaveBeenCalled();
  });
});

describe("authorization", () => {
  it("router applies authMiddleware before the schedule routes (same gate as PATCH)", () => {
    const stack = (pipelineRouter as any).stack as any[];
    const authIdx = stack.findIndex((l) => !l.route && l.handle === authMw);
    const pauseIdx = stack.findIndex((l) => l.route?.path === "/:id/schedule/pause");
    const resumeIdx = stack.findIndex((l) => l.route?.path === "/:id/schedule/resume");
    expect(authIdx).toBeGreaterThanOrEqual(0);
    expect(authIdx).toBeLessThan(pauseIdx);
    expect(authIdx).toBeLessThan(resumeIdx);
  });
});

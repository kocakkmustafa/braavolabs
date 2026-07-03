/**
 * E4/T3 — pipeline router mutations sync the BullMQ scheduler.
 *
 * Router handlers are exercised directly (extracted from the Express Router
 * stack), same zero-network harness as run/handoff-router.test.ts. Middlewares
 * are mocked pass-through; registerSchedule/removeSchedule are mocked so we
 * assert the router calls them with the right pipeline on the right transition.
 *
 * Covered (plan T3 birebir):
 *   • POST / create SCHEDULED+enabled+schedule → registerSchedule
 *   • POST / create MANUAL → neither register nor remove
 *   • POST / create SCHEDULED without schedule → zod 400 (SCHED-06)
 *   • PATCH /:id enabled:false → removeSchedule
 *   • PATCH /:id still SCHEDULED+enabled → registerSchedule
 *   • DELETE /:id → removeSchedule
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const companyFindFirst = vi.hoisted(() => vi.fn());
const pipelineCreate = vi.hoisted(() => vi.fn());
const pipelineFindUnique = vi.hoisted(() => vi.fn());
const pipelineUpdate = vi.hoisted(() => vi.fn());
const pipelineDelete = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    company: { findFirst: (...a: unknown[]) => companyFindFirst(...a) },
    pipeline: {
      create: (...a: unknown[]) => pipelineCreate(...a),
      findUnique: (...a: unknown[]) => pipelineFindUnique(...a),
      update: (...a: unknown[]) => pipelineUpdate(...a),
      delete: (...a: unknown[]) => pipelineDelete(...a),
    },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
  },
}));

vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
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

const baseCreateBody = {
  companyId: "co-1",
  name: "My pipeline",
  steps: [{ name: "s1", agentRole: "worker", order: 0 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  companyFindFirst.mockResolvedValue({ id: "co-1", tenantId: "tenant-1" });
  activityLogCreate.mockResolvedValue({});
  registerScheduleMock.mockResolvedValue(undefined);
  removeScheduleMock.mockResolvedValue(undefined);
});

describe("POST /pipelines — create", () => {
  const handler = getHandler(pipelineRouter, "post", "/");

  it("SCHEDULED + enabled + schedule → registerSchedule", async () => {
    const created = { id: "pipe-1", trigger: "SCHEDULED", enabled: true, schedule: "0 9 * * *" };
    pipelineCreate.mockResolvedValue(created);

    const { res, nextErr } = await invoke(handler, {
      body: { ...baseCreateBody, trigger: "SCHEDULED", schedule: "0 9 * * *" },
    });

    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(registerScheduleMock).toHaveBeenCalledWith(created);
    expect(removeScheduleMock).not.toHaveBeenCalled();
  });

  it("MANUAL → neither register nor remove", async () => {
    pipelineCreate.mockResolvedValue({ id: "pipe-2", trigger: "MANUAL", enabled: true, schedule: null });

    const { nextErr } = await invoke(handler, { body: { ...baseCreateBody, trigger: "MANUAL" } });

    expect(nextErr).toBeUndefined();
    expect(registerScheduleMock).not.toHaveBeenCalled();
    expect(removeScheduleMock).not.toHaveBeenCalled();
  });

  it("SCHEDULED without schedule → zod validation error (SCHED-06), no create", async () => {
    const { nextErr } = await invoke(handler, {
      body: { ...baseCreateBody, trigger: "SCHEDULED" },
    });

    expect(nextErr).toBeDefined(); // ZodError forwarded to next()
    expect(pipelineCreate).not.toHaveBeenCalled();
    expect(registerScheduleMock).not.toHaveBeenCalled();
  });

  it("SCHEDULED with an invalid cron → zod validation error", async () => {
    const { nextErr } = await invoke(handler, {
      body: { ...baseCreateBody, trigger: "SCHEDULED", schedule: "not-a-cron" },
    });
    expect(nextErr).toBeDefined();
    expect(pipelineCreate).not.toHaveBeenCalled();
  });
});

describe("PATCH /pipelines/:id — update", () => {
  const handler = getHandler(pipelineRouter, "patch", "/:id");

  beforeEach(() => {
    pipelineFindUnique.mockResolvedValue({
      id: "pipe-1",
      steps: [],
      company: { tenantId: "tenant-1" },
    });
  });

  it("enabled:false → removeSchedule (pause)", async () => {
    pipelineUpdate.mockResolvedValue({
      id: "pipe-1", trigger: "SCHEDULED", enabled: false, schedule: "0 9 * * *",
    });

    const { nextErr } = await invoke(handler, { params: { id: "pipe-1" }, body: { enabled: false } });

    expect(nextErr).toBeUndefined();
    expect(removeScheduleMock).toHaveBeenCalledWith("pipe-1");
    expect(registerScheduleMock).not.toHaveBeenCalled();
  });

  it("still SCHEDULED + enabled + schedule → registerSchedule", async () => {
    const updated = { id: "pipe-1", trigger: "SCHEDULED", enabled: true, schedule: "*/5 * * * *" };
    pipelineUpdate.mockResolvedValue(updated);

    const { nextErr } = await invoke(handler, {
      params: { id: "pipe-1" }, body: { schedule: "*/5 * * * *" },
    });

    expect(nextErr).toBeUndefined();
    expect(registerScheduleMock).toHaveBeenCalledWith(updated);
    expect(removeScheduleMock).not.toHaveBeenCalled();
  });

  it("trigger flipped to MANUAL → removeSchedule", async () => {
    pipelineUpdate.mockResolvedValue({ id: "pipe-1", trigger: "MANUAL", enabled: true, schedule: null });

    const { nextErr } = await invoke(handler, { params: { id: "pipe-1" }, body: { trigger: "MANUAL" } });

    expect(nextErr).toBeUndefined();
    expect(removeScheduleMock).toHaveBeenCalledWith("pipe-1");
    expect(registerScheduleMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /pipelines/:id", () => {
  const handler = getHandler(pipelineRouter, "delete", "/:id");

  it("removes the scheduler (SCHED-04)", async () => {
    pipelineFindUnique.mockResolvedValue({ id: "pipe-1", company: { tenantId: "tenant-1" } });
    pipelineDelete.mockResolvedValue({});

    const { nextErr } = await invoke(handler, { params: { id: "pipe-1" } });

    expect(nextErr).toBeUndefined();
    expect(removeScheduleMock).toHaveBeenCalledWith("pipe-1");
  });
});

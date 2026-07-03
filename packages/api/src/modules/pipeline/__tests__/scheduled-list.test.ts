/**
 * E4/T5 — GET /pipelines/scheduled merges DB rows (name/schedule/enabled/
 * lastRunAt) with the live JobScheduler nextRunAt. Every field is real; an
 * empty result is a genuine [] (no placeholders).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const companyFindFirst = vi.hoisted(() => vi.fn());
const pipelineFindMany = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: {
    company: { findFirst: (...a: unknown[]) => companyFindFirst(...a) },
    pipeline: { findMany: (...a: unknown[]) => pipelineFindMany(...a) },
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

// The listing endpoint reads live schedulers from the dedicated scheduleQueue
// (E4), not runQueue.
const getJobSchedulers = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/queue", () => ({
  runQueue: { getJobSchedulers: vi.fn().mockResolvedValue([]) },
  scheduleQueue: { getJobSchedulers: (...a: unknown[]) => getJobSchedulers(...a) },
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

const handler = getHandler(pipelineRouter, "get", "/scheduled");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /pipelines/scheduled", () => {
  it("merges DB lastRunAt with scheduler nextRunAt", async () => {
    const lastRun = new Date("2026-07-03T09:00:00.000Z");
    const nextMs = Date.parse("2026-07-04T09:00:00.000Z");
    pipelineFindMany.mockResolvedValue([
      { id: "A", name: "Daily", schedule: "0 9 * * *", enabled: true, lastRunAt: lastRun, companyId: "co-1" },
      { id: "B", name: "Never fired", schedule: "0 8 * * *", enabled: true, lastRunAt: null, companyId: "co-1" },
    ]);
    getJobSchedulers.mockResolvedValue([{ key: "A", next: nextMs }]);

    const { res, nextErr } = await invoke(handler, {});

    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual([
      {
        id: "A", name: "Daily", companyId: "co-1", schedule: "0 9 * * *", enabled: true,
        nextRunAt: new Date(nextMs).toISOString(),
        lastRunAt: lastRun.toISOString(),
      },
      {
        id: "B", name: "Never fired", companyId: "co-1", schedule: "0 8 * * *", enabled: true,
        nextRunAt: null, // no scheduler entry for B
        lastRunAt: null,
      },
    ]);
  });

  it("returns a genuine empty [] when no scheduled pipelines exist", async () => {
    pipelineFindMany.mockResolvedValue([]);
    getJobSchedulers.mockResolvedValue([]);

    const { res, nextErr } = await invoke(handler, {});

    expect(nextErr).toBeUndefined();
    expect(res.body).toEqual([]);
  });

  it("404s when a companyId filter points at another tenant's company", async () => {
    companyFindFirst.mockResolvedValue(null);

    const { nextErr } = await invoke(handler, { query: { companyId: "co-foreign" } });

    expect(nextErr).toBeDefined();
    expect(pipelineFindMany).not.toHaveBeenCalled();
  });
});

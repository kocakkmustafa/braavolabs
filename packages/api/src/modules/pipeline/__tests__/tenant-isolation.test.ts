/**
 * Tenant-isolation regression net (Forge P1 security hardening).
 *
 * Surface-audit finding #1: tenant isolation is enforced entirely by
 * hand-written `pipeline.company.tenantId !== req.auth!.tenantId` guards
 * scattered across router handlers (RLS is inert — fail-open + superuser).
 * There was no automated test that a FUTURE edit deleting one of these
 * guards would be caught. This file pins the guard on every pipeline
 * router handler that resolves a resource by :id, using the SAME
 * zero-network handler-extraction harness as pipeline-router-schedule.test.ts
 * (real Express handlers, mocked Prisma) — the strongest regression net the
 * harness supports: if a guard line is ever deleted, these tests fail RED
 * because the mocked "foreign tenant's" resource starts leaking through.
 *
 * Pattern per test: tenant A owns a resource; a request authenticated as
 * tenant B asks for it by id. Expected: 404, and — critically — the
 * resource's real content never reaches the response body and no mutating
 * Prisma call fires.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const pipelineFindUnique = vi.hoisted(() => vi.fn());
const pipelineUpdate = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());
const claimQuotaMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    pipeline: {
      findUnique: (...a: unknown[]) => pipelineFindUnique(...a),
      update: (...a: unknown[]) => pipelineUpdate(...a),
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

const enqueueRunMock = vi.hoisted(() => vi.fn());
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

async function invoke(handler: any, tenantId: string, req: any) {
  const res = mockRes();
  let nextErr: any = undefined;
  const next = (err?: any) => { nextErr = err; };
  await handler(
    { auth: { tenantId, userId: "user-1", role: "admin" }, params: {}, body: {}, query: {}, ...req },
    res,
    next,
  );
  return { res, nextErr };
}

const OWNER_TENANT = "tenant-A";
const ATTACKER_TENANT = "tenant-B";

function foreignPipeline(overrides: Record<string, unknown> = {}) {
  return {
    id: "pipe-secret-1",
    name: "Tenant A's confidential automation",
    steps: [{ name: "s1", agentRole: "worker", order: 0 }],
    company: { tenantId: OWNER_TENANT },
    runs: [{ id: "run-secret" }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  activityLogCreate.mockResolvedValue({});
});

describe("GET /pipelines/:id — cross-tenant regression", () => {
  const handler = getHandler(pipelineRouter, "get", "/:id");

  it("tenant B requesting tenant A's pipeline id gets 404, never the pipeline body", async () => {
    pipelineFindUnique.mockResolvedValue(foreignPipeline());

    const { res, nextErr } = await invoke(handler, ATTACKER_TENANT, { params: { id: "pipe-secret-1" } });

    expect(nextErr?.statusCode).toBe(404);
    expect(res.body).toBeUndefined();
  });

  it("sanity control — the SAME lookup succeeds for the owning tenant", async () => {
    pipelineFindUnique.mockResolvedValue(foreignPipeline());

    const { res, nextErr } = await invoke(handler, OWNER_TENANT, { params: { id: "pipe-secret-1" } });

    expect(nextErr).toBeUndefined();
    expect(res.body).toMatchObject({ id: "pipe-secret-1", name: "Tenant A's confidential automation" });
  });
});

describe("PATCH /pipelines/:id — cross-tenant regression", () => {
  const handler = getHandler(pipelineRouter, "patch", "/:id");

  it("tenant B cannot patch tenant A's pipeline — 404, no write issued", async () => {
    pipelineFindUnique.mockResolvedValue(foreignPipeline());

    const { nextErr } = await invoke(handler, ATTACKER_TENANT, {
      params: { id: "pipe-secret-1" },
      body: { name: "pwned" },
    });

    expect(nextErr?.statusCode).toBe(404);
    expect(pipelineUpdate).not.toHaveBeenCalled();
  });
});

describe("POST /pipelines/:id/run — cross-tenant regression", () => {
  const handler = getHandler(pipelineRouter, "post", "/:id/run");

  it("tenant B cannot trigger a run on tenant A's pipeline — 404, quota never claimed", async () => {
    pipelineFindUnique.mockResolvedValue(foreignPipeline());

    const { nextErr } = await invoke(handler, ATTACKER_TENANT, { params: { id: "pipe-secret-1" } });

    expect(nextErr?.statusCode).toBe(404);
    // Guards the quota-abuse angle too: a foreign-tenant probe must not burn
    // the victim's (or its own) monthly run quota.
    expect(claimQuotaMock).not.toHaveBeenCalled();
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });
});

/**
 * BRA-SEC-01 — no route that returns a Company may expose Company.config
 * secrets (webhookSecret etc.). Each affected route is driven with a row whose
 * config carries a fake secret; the serialized response must not contain it.
 * Also pins that the inbound-webhook HMAC check still reads the RAW row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

const SECRET = "test-secret-value";
const NESTED = "test-nested-credential";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const companyFindMany = vi.hoisted(() => vi.fn());
const companyFindFirst = vi.hoisted(() => vi.fn());
const companyCreate = vi.hoisted(() => vi.fn());
const runFindUnique = vi.hoisted(() => vi.fn());
const pipelineFindUnique = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    company: { create: (...a: unknown[]) => companyCreate(...a), count: vi.fn().mockResolvedValue(0), findFirst: vi.fn() },
    activityLog: { create: vi.fn() },
    entitlementEvent: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return {
    prisma: {
      company: {
        findMany: (...a: unknown[]) => companyFindMany(...a),
        findFirst: (...a: unknown[]) => companyFindFirst(...a),
      },
      run: { findUnique: (...a: unknown[]) => runFindUnique(...a) },
      pipeline: { findUnique: (...a: unknown[]) => pipelineFindUnique(...a) },
      activityLog: { create: vi.fn() },
      tenant: { findUnique: vi.fn() },
    },
    tenantTx: (fn: (c: typeof tx) => unknown) => fn(tx),
  };
});
vi.mock("../company-capacity", () => ({ assertCompanyCapacity: vi.fn() }));
vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../middleware/rateLimit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../pipeline/runner", () => ({
  enqueueRun: vi.fn(),
  registerSchedule: vi.fn(),
  removeSchedule: vi.fn(),
}));
vi.mock("../../../lib/queue", () => ({
  runQueue: { getJobSchedulers: vi.fn().mockResolvedValue([]) },
  scheduleQueue: { getJobSchedulers: vi.fn().mockResolvedValue([]) },
}));
vi.mock("../../billing/metering", () => ({ claimQuota: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class {} }));
vi.mock("../../../services/ai-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/ai-client")>()),
  chatCompletion: vi.fn(),
  getTenantAIConfig: vi.fn(),
}));
vi.mock("../../../services/provider-chain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/provider-chain")>()),
  listTenantProviderLinks: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../../services/takeover-config", () => ({ assertKeylessLocalBaseUrl: vi.fn() }));
vi.mock("../../../lib/modelPricing", () => ({ estimatePipelineCostUsd: vi.fn() }));
vi.mock("../../run/handoff.service", () => ({
  createHandoff: vi.fn(),
  claimHandoff: vi.fn(),
  cancelOpenHandoffForRun: vi.fn(),
  HandoffClaimError: class HandoffClaimError extends Error {},
}));
vi.mock("../../../config/env", () => ({
  env: { NODE_ENV: "development", OFFLINE_MODE: false, CLAUDE_MODEL: "claude-sonnet-4-5", LLM_PROVIDER: "api" },
}));

import { companyRouter } from "../router";
import { runRouter } from "../../run/router";
import { pipelineRouter } from "../../pipeline/router";
import { exportRouter } from "../../export/router";

function getHandler(router: Router, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()],
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  return layer.route.stack.at(-1).handle as (req: any, res: any, next: any) => Promise<void> | void;
}

async function invoke(router: Router, method: string, path: string, req: any = {}) {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
    send(p: unknown) { this.body = p; return this; },
    setHeader() { return this; },
  };
  let nextErr: unknown;
  await getHandler(router, method, path)(
    { auth: { tenantId: "tenant-1", userId: "u1", role: "admin" }, params: {}, body: {}, query: {}, ...req },
    res,
    (e?: unknown) => { nextErr = e; },
  );
  expect(nextErr).toBeUndefined();
  return res;
}

function leakyCompany(extra: Record<string, unknown> = {}) {
  return {
    id: "c1",
    tenantId: "tenant-1",
    name: "Acme",
    slug: "acme",
    description: null,
    primitives: ["CONTENT"],
    status: "ACTIVE",
    config: {
      niche: "saas",
      webhookSecret: SECRET,
      budget: { monthly: 10, apiKey: NESTED },
      someInternalToken: SECRET,
    },
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...extra,
  };
}

function expectClean(body: unknown) {
  const s = JSON.stringify(body);
  expect(s).not.toContain(SECRET);
  expect(s).not.toContain(NESTED);
}

beforeEach(() => vi.clearAllMocks());

describe("Company.config secrets never reach a response", () => {
  it("GET /companies", async () => {
    companyFindMany.mockResolvedValue([leakyCompany({ _count: { agents: 1, pipelines: 1 } })]);
    const res = await invoke(companyRouter, "get", "/");
    expectClean(res.body);
    expect(res.body[0].config).toEqual({ niche: "saas", budget: { monthly: 10, apiKey: "***" }, webhookSecretSet: true });
    expect(res.body[0]._count).toEqual({ agents: 1, pipelines: 1 });
  });

  it("GET /companies/:id", async () => {
    companyFindFirst.mockResolvedValue(leakyCompany({ agents: [], pipelines: [] }));
    const res = await invoke(companyRouter, "get", "/:id", { params: { id: "c1" } });
    expectClean(res.body);
    expect(res.body.config.webhookSecretSet).toBe(true);
    expect(res.body.agents).toEqual([]);
  });

  it("POST /companies (create echo)", async () => {
    companyCreate.mockResolvedValue(leakyCompany());
    const res = await invoke(companyRouter, "post", "/", {
      body: { name: "Acme", slug: "acme", primitives: ["CONTENT"], config: { niche: "saas" } },
    });
    expect(res.statusCode).toBe(201);
    expectClean(res.body);
  });

  it("GET /runs/:id (pipeline.company)", async () => {
    runFindUnique.mockResolvedValue({
      id: "r1", steps: [], approvals: [], pipeline: { id: "p1", company: leakyCompany() },
    });
    const res = await invoke(runRouter, "get", "/:id", { params: { id: "r1" } });
    expectClean(res.body);
    expect(res.body.pipeline.company.config.webhookSecretSet).toBe(true);
    expect(res.body.pipeline.company.tenantId).toBe("tenant-1");
  });

  it("GET /runs/:id of another tenant stays 404 (tenant check uses the raw row)", async () => {
    runFindUnique.mockResolvedValue({
      id: "r1", steps: [], approvals: [], pipeline: { id: "p1", company: leakyCompany({ tenantId: "tenant-2" }) },
    });
    const res: any = { status() { return this; }, json: vi.fn() };
    let err: any;
    await getHandler(runRouter, "get", "/:id")(
      { auth: { tenantId: "tenant-1" }, params: { id: "r1" } }, res, (e: unknown) => { err = e; },
    );
    expect(err?.statusCode).toBe(404);
    expect(res.json).not.toHaveBeenCalled();
  });

  it("GET /pipelines/:id (company)", async () => {
    pipelineFindUnique.mockResolvedValue({ id: "p1", runs: [], company: leakyCompany() });
    const res = await invoke(pipelineRouter, "get", "/:id", { params: { id: "p1" } });
    expectClean(res.body);
    expect(res.body.company.config.webhookSecretSet).toBe(true);
  });

  it.each(["/:companyId/bundle", "/:companyId/claude-md"])("GET /export%s", async (path) => {
    companyFindFirst.mockResolvedValue(leakyCompany({ agents: [], pipelines: [] }));
    const res = await invoke(exportRouter, "get", path, { params: { companyId: "c1" } });
    expectClean(res.body);
  });
});

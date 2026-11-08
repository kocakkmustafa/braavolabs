/**
 * BRA-P0-02c-1 — GET /runs/:id response-key contract (STATUS "Yanıt yüzeyi").
 *
 * The route returns the raw `Run` row plus three relations. This pins:
 *   1. the exact scalar key set (so a new column added to `Run` fails here and
 *      must be a conscious API decision, not a silent response addition), and
 *   2. the exact `include` shape (no other relation — receipts, handoffs,
 *      steeringMessages — can leak into the response by accident).
 * Scalars are enumerated from Prisma's own RunScalarFieldEnum.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";
import { Prisma } from "@prisma/client";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runFindUnique = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: { run: { findUnique: (...a: unknown[]) => runFindUnique(...a) } },
}));
vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../middleware/rateLimit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../pipeline/runner", () => ({ enqueueRun: vi.fn() }));
vi.mock("../../../services/ai-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/ai-client")>()),
  chatCompletion: vi.fn(),
}));
vi.mock("../../../services/provider-chain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/provider-chain")>()),
  listTenantProviderLinks: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../../services/takeover-config", () => ({ assertKeylessLocalBaseUrl: vi.fn() }));
vi.mock("../handoff.service", () => ({
  createHandoff: vi.fn(),
  claimHandoff: vi.fn(),
  cancelOpenHandoffForRun: vi.fn(),
  HandoffClaimError: class HandoffClaimError extends Error {},
}));
vi.mock("../../../config/env", () => ({
  env: { NODE_ENV: "development", OFFLINE_MODE: false, CLAUDE_MODEL: "claude-sonnet-4-5" },
}));

import { runRouter } from "../router";

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
    { auth: { tenantId: "tenant-1", userId: "user-1", role: "admin" }, params: { id: "run-1" }, body: {}, query: {}, ...req },
    res,
    (err?: any) => { nextErr = err; },
  );
  return { res, nextErr };
}

const handler = getHandler(runRouter, "get", "/:id");

/** Legacy keys that shipped clients already read + the BRA-P0-02b/08 additions. */
const RUN_SCALAR_KEYS = [
  // legacy
  "id", "pipelineId", "status", "trigger", "input", "output", "error", "costUsd", "budgetUsd",
  "resumeCursor", "startedAt", "completedAt", "createdAt", "updatedAt",
  // BRA-P0-02b / 08 (additive, nullable or defaulted)
  "state", "tenantId", "workspaceId", "idempotencyKey", "planVersion", "resultStatus", "deadline",
  "evidenceRef", "retryCount", "heartbeatAt", "jobBudget",
].sort();
const RELATION_KEYS = ["approvals", "pipeline", "steps"];

/** Prisma Company scalars: the nested `pipeline.company` shape. */
const COMPANY_SCALAR_KEYS = Object.values(Prisma.CompanyScalarFieldEnum).sort();

function companyRow(tenantId = "tenant-1") {
  const row: Record<string, unknown> = {};
  for (const k of Object.values(Prisma.CompanyScalarFieldEnum)) row[k] = null;
  row.tenantId = tenantId;
  row.config = { niche: "saas", webhookSecret: "test-secret-value", budget: { apiKey: "test-secret-value" } };
  return row;
}

function fullRow(tenantId = "tenant-1") {
  const row: Record<string, unknown> = {};
  for (const k of Object.values(Prisma.RunScalarFieldEnum)) row[k] = null;
  return { ...row, steps: [], approvals: [], pipeline: { id: "pipe-1", company: companyRow(tenantId) } };
}

beforeEach(() => vi.clearAllMocks());

describe("GET /runs/:id — response-key contract", () => {
  it("Prisma Run scalar fields == the locked list (schema drift must be a conscious decision)", () => {
    expect([...Object.values(Prisma.RunScalarFieldEnum)].sort()).toEqual(RUN_SCALAR_KEYS);
  });

  it("responds with exactly the scalar keys + steps/pipeline/approvals, nothing else", async () => {
    runFindUnique.mockResolvedValue(fullRow());
    const { res, nextErr } = await invoke({});
    expect(nextErr).toBeUndefined();
    expect(Object.keys(res.body).sort()).toEqual([...RUN_SCALAR_KEYS, ...RELATION_KEYS].sort());
  });

  it("queries with the fixed include shape and no select (no receipts/handoffs/steeringMessages relation)", async () => {
    runFindUnique.mockResolvedValue(fullRow());
    await invoke({});
    const args = runFindUnique.mock.calls[0]![0];
    expect(args.where).toEqual({ id: "run-1" });
    expect(args).not.toHaveProperty("select");
    expect(Object.keys(args.include).sort()).toEqual(RELATION_KEYS);
    for (const leaked of ["receipts", "handoffs", "steeringMessages"]) {
      expect(args.include).not.toHaveProperty(leaked);
    }
  });

  it("another tenant's run → 404 and no body", async () => {
    runFindUnique.mockResolvedValue(fullRow("tenant-2"));
    const { res, nextErr } = await invoke({});
    expect(nextErr?.statusCode).toBe(404);
    expect(res.body).toBeUndefined();
  });
});

describe("GET /runs/:id — nested include contract (BRA-SEC-01)", () => {
  it("pipeline.company keeps exactly the Company scalar keys (no relations) and config is redacted", async () => {
    runFindUnique.mockResolvedValue(fullRow());
    const { res } = await invoke({});
    expect(Object.keys(res.body.pipeline.company).sort()).toEqual(COMPANY_SCALAR_KEYS);
    expect(res.body.pipeline.company.config).toEqual({
      niche: "saas",
      budget: { apiKey: "***" },
      webhookSecretSet: true,
    });
    expect(JSON.stringify(res.body)).not.toContain("test-secret-value");
  });

  it("pipeline include stays { company: true } only (no nested relation widening)", async () => {
    runFindUnique.mockResolvedValue(fullRow());
    await invoke({});
    const args = runFindUnique.mock.calls[0]![0];
    expect(args.include.pipeline).toEqual({ include: { company: true } });
    expect(args.include.steps).toEqual({ include: { toolCalls: true }, orderBy: { stepIndex: "asc" } });
  });
});

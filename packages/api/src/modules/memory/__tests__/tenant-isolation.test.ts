/**
 * Tenant-isolation regression net (Forge P1 security hardening) — memory
 * router. Pins the `memoryItem.company.tenantId !== req.auth!.tenantId`
 * guards on the graph-traversal endpoints (GET /:id/related, POST /edges)
 * with real handler invocation (mocked Prisma + mocked @ai-company-os/memory).
 * These are the highest-value guards in this module: memory is the tenant's
 * accumulated episodic/semantic/procedural knowledge — a dropped guard here
 * doesn't just leak one row, it lets a foreign tenant walk the whole graph
 * via getRelatedMemories.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

const memoryItemFindUnique = vi.hoisted(() => vi.fn());
const companyFindFirst = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    memoryItem: { findUnique: (...a: unknown[]) => memoryItemFindUnique(...a) },
    company: { findFirst: (...a: unknown[]) => companyFindFirst(...a) },
    activityLog: { create: vi.fn() },
  },
}));

vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../middleware/rateLimit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const getRelatedMemoriesMock = vi.hoisted(() => vi.fn());
vi.mock("@ai-company-os/memory", () => ({
  searchMemory: vi.fn(),
  searchMemoryText: vi.fn(),
  storeEpisodicMemory: vi.fn(),
  storeSemanticMemory: vi.fn(),
  storeProceduralMemory: vi.fn(),
  addEdge: vi.fn(),
  getRelatedMemories: (...a: unknown[]) => getRelatedMemoriesMock(...a),
  runConsolidation: vi.fn(),
}));

import { memoryRouter } from "../router";

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

function foreignMemoryItem(id = "mem-secret-1") {
  return { id, content: "tenant A's private playbook", company: { tenantId: OWNER_TENANT } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /memory/:id/related — cross-tenant regression", () => {
  const handler = getHandler(memoryRouter, "get", "/:id/related");

  it("tenant B cannot walk tenant A's memory graph — 404, getRelatedMemories never called", async () => {
    memoryItemFindUnique.mockResolvedValue(foreignMemoryItem());

    const { res, nextErr } = await invoke(handler, ATTACKER_TENANT, { params: { id: "mem-secret-1" } });

    expect(nextErr?.statusCode).toBe(404);
    expect(res.body).toBeUndefined();
    // The critical guard: a dropped tenant check here would still call
    // getRelatedMemories and hand the FULL related-memory graph to tenant B.
    expect(getRelatedMemoriesMock).not.toHaveBeenCalled();
  });
});

describe("POST /memory/edges — cross-tenant regression", () => {
  const handler = getHandler(memoryRouter, "post", "/edges");

  it("tenant B cannot link an edge FROM tenant A's memory item — 404, source checked first", async () => {
    memoryItemFindUnique.mockResolvedValue(foreignMemoryItem("mem-from-secret"));

    const { nextErr } = await invoke(handler, ATTACKER_TENANT, {
      body: { fromId: "mem-from-secret", toId: "mem-own-1", relation: "supports" },
    });

    expect(nextErr?.statusCode).toBe(404);
    expect(nextErr?.message).toMatch(/Source memory item not found/);
  });

  it("tenant B cannot link an edge TO tenant A's memory item, even from their own source", async () => {
    memoryItemFindUnique.mockImplementation(async (args: any) =>
      args.where.id === "mem-own-1"
        ? { id: "mem-own-1", company: { tenantId: ATTACKER_TENANT } }
        : foreignMemoryItem("mem-to-secret"),
    );

    const { nextErr } = await invoke(handler, ATTACKER_TENANT, {
      body: { fromId: "mem-own-1", toId: "mem-to-secret", relation: "supports" },
    });

    expect(nextErr?.statusCode).toBe(404);
    expect(nextErr?.message).toMatch(/Target memory item not found/);
  });
});

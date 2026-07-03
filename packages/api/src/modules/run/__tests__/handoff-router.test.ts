/**
 * E3/T5 — handoff API endpoints + provider LIST + rerun guard (plan T5 test
 * list, adversarial B4c/B5.2/B6.3). Router handlers are exercised directly
 * (extracted from the Router stack) with a mock req/res/next and fully mocked
 * prisma / services — same zero-network philosophy as the T3 service tests, but
 * asserting the HTTP surface (status codes, PAUSED transition, 409/400 gates).
 *
 * Covered (plan T5 birebir):
 *   • unauthorized tenant → 404 (handoff, continue, list, rerun)
 *   • RUNNING run handoff → run PAUSED + ledger OPEN (checkpoint null)
 *   • continue while checkpoint null → 409 CHECKPOINT_PENDING
 *   • continue past the stale threshold → claim succeeds (200)
 *   • continue invalid provider → 400
 *   • continue prod keyless-local without baseUrl → 400 (B4c)
 *   • rerun cancels an OPEN ledger / 409s on a CLAIMED one (B6.3)
 *   • GET /:id/handoffs list is tenant-scoped
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

// ── Mocks (declared before importing the SUT router) ──

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runFindFirst = vi.hoisted(() => vi.fn());
const runUpdate = vi.hoisted(() => vi.fn());
const runStepFindUnique = vi.hoisted(() => vi.fn());
const runStepUpdate = vi.hoisted(() => vi.fn());
const handoffFindFirst = vi.hoisted(() => vi.fn());
const handoffFindMany = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    run: {
      findFirst: (...a: unknown[]) => runFindFirst(...a),
      update: (...a: unknown[]) => runUpdate(...a),
    },
    runStep: {
      findUnique: (...a: unknown[]) => runStepFindUnique(...a),
      update: (...a: unknown[]) => runStepUpdate(...a),
    },
    handoffLedger: {
      findFirst: (...a: unknown[]) => handoffFindFirst(...a),
      findMany: (...a: unknown[]) => handoffFindMany(...a),
    },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
  },
}));

// authMiddleware / rateLimit — pass-through (no JWT, no Redis). We inject
// req.auth ourselves in the test harness.
vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../middleware/rateLimit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const enqueueRunMock = vi.hoisted(() => vi.fn());
vi.mock("../../pipeline/runner", () => ({ enqueueRun: (...a: unknown[]) => enqueueRunMock(...a) }));

const getTenantAIConfigMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/ai-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/ai-client")>();
  return {
    ...actual,
    getTenantAIConfig: (...a: unknown[]) => getTenantAIConfigMock(...a),
    chatCompletion: vi.fn(),
  };
});

const listTenantProviderLinksMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/provider-chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/provider-chain")>();
  return {
    ...actual,
    listTenantProviderLinks: (...a: unknown[]) => listTenantProviderLinksMock(...a),
  };
});

const createHandoffMock = vi.hoisted(() => vi.fn());
const claimHandoffMock = vi.hoisted(() => vi.fn());
const cancelOpenHandoffForRunMock = vi.hoisted(() => vi.fn());
vi.mock("../handoff.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../handoff.service")>();
  return {
    ...actual,
    createHandoff: (...a: unknown[]) => createHandoffMock(...a),
    claimHandoff: (...a: unknown[]) => claimHandoffMock(...a),
    cancelOpenHandoffForRun: (...a: unknown[]) => cancelOpenHandoffForRunMock(...a),
    // HandoffClaimError stays REAL — the router branches on it.
  };
});

// env — default development; individual tests override NODE_ENV.
const envMock = vi.hoisted(() => ({ NODE_ENV: "development", OFFLINE_MODE: false }));
vi.mock("../../../config/env", () => ({ env: envMock }));

import { runRouter } from "../router";
import { HandoffClaimError } from "../handoff.service";

// ── Router handler harness ──
// Pull the terminal handler for a METHOD+PATH out of the Express Router stack
// and drive it with a fake req/res. Middlewares (auth, rateLimit) are mocked to
// pass-through above, so the LAST layer on the route is the real handler.
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

async function invoke(
  handler: (req: any, res: any, next: any) => Promise<void> | void,
  req: any,
) {
  const res = mockRes();
  let nextErr: any = undefined;
  const next = (err?: any) => { nextErr = err; };
  await handler({ auth: { tenantId: "tenant-1", userId: "user-1", role: "admin" }, params: {}, body: {}, query: {}, ...req }, res, next);
  return { res, nextErr };
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.NODE_ENV = "development";
  envMock.OFFLINE_MODE = false;
  runFindFirst.mockResolvedValue({ id: "run-1", status: "RUNNING" });
  runUpdate.mockResolvedValue({});
  activityLogCreate.mockResolvedValue({});
  enqueueRunMock.mockResolvedValue(undefined);
  getTenantAIConfigMock.mockResolvedValue({ provider: "ANTHROPIC", model: "claude-sonnet-4-5" });
  listTenantProviderLinksMock.mockResolvedValue([]);
  createHandoffMock.mockResolvedValue({ id: "hl-1", checkpoint: null });
  claimHandoffMock.mockResolvedValue({ id: "hl-1", status: "CLAIMED", toProvider: "OLLAMA" });
  cancelOpenHandoffForRunMock.mockResolvedValue(true);
  handoffFindFirst.mockResolvedValue({ id: "hl-1", status: "OPEN" });
  handoffFindMany.mockResolvedValue([]);
});

// ── POST /:id/handoff ──

describe("POST /runs/:id/handoff", () => {
  const handler = getHandler(runRouter, "post", "/:id/handoff");

  it("unauthorized / cross-tenant run → 404", async () => {
    runFindFirst.mockResolvedValue(null);
    const { nextErr } = await invoke(handler, { params: { id: "run-x" } });
    expect(nextErr?.statusCode).toBe(404);
  });

  it("RUNNING run → OPEN ledger opened FIRST (checkpoint null), THEN run PAUSED, 201", async () => {
    runFindFirst.mockResolvedValue({ id: "run-1", status: "RUNNING" });
    // Track call order: createHandoff must run BEFORE the PAUSE update so the
    // live loop owns the checkpoint (createHandoff sees a RUNNING run).
    const order: string[] = [];
    createHandoffMock.mockImplementation(async () => { order.push("createHandoff"); return { id: "hl-1", checkpoint: null }; });
    runUpdate.mockImplementation(async () => { order.push("pause"); return {}; });

    const { res, nextErr } = await invoke(handler, { params: { id: "run-1" }, body: { reason: "switch model" } });

    expect(nextErr).toBeUndefined();
    expect(order).toEqual(["createHandoff", "pause"]); // ledger opened before PAUSE
    expect(runUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "PAUSED" } }));
    // createHandoff called with freezeFromTranscript=false (live loop owns it).
    expect(createHandoffMock.mock.calls[0][0]).toMatchObject({ runId: "run-1", reason: "MANUAL", freezeFromTranscript: false });
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ success: true, status: "PAUSED", checkpointPending: true });
  });

  it("FAILED run → ledger copies transcript now (freezeFromTranscript=true), no PAUSE", async () => {
    runFindFirst.mockResolvedValue({ id: "run-1", status: "FAILED" });
    createHandoffMock.mockResolvedValue({ id: "hl-1", checkpoint: { turn: 2 } });
    const { res, nextErr } = await invoke(handler, { params: { id: "run-1" } });

    expect(nextErr).toBeUndefined();
    expect(createHandoffMock.mock.calls[0][0]).toMatchObject({ freezeFromTranscript: true });
    expect(runUpdate).not.toHaveBeenCalled(); // no PAUSE for a non-RUNNING run
    expect(res.body).toMatchObject({ success: true, status: "FAILED", checkpointPending: false });
  });

  it("finished run → 400", async () => {
    runFindFirst.mockResolvedValue({ id: "run-1", status: "COMPLETED" });
    const { nextErr } = await invoke(handler, { params: { id: "run-1" } });
    expect(nextErr?.statusCode).toBe(400);
  });
});

// ── POST /:id/continue ──

describe("POST /runs/:id/continue", () => {
  const handler = getHandler(runRouter, "post", "/:id/continue");

  it("unauthorized run → 404", async () => {
    runFindFirst.mockResolvedValue(null);
    const { nextErr } = await invoke(handler, { params: { id: "run-x" }, body: { provider: "OLLAMA" } });
    expect(nextErr?.statusCode).toBe(404);
  });

  it("invalid provider → 400", async () => {
    const { nextErr } = await invoke(handler, { params: { id: "run-1" }, body: { provider: "NOTAPROVIDER" } });
    expect(nextErr?.statusCode).toBe(400);
    expect(claimHandoffMock).not.toHaveBeenCalled();
  });

  it("no OPEN ledger → 400", async () => {
    handoffFindFirst.mockResolvedValue(null);
    const { nextErr } = await invoke(handler, { params: { id: "run-1" }, body: { provider: "OLLAMA", baseUrl: "http://x:11434/v1" } });
    expect(nextErr?.statusCode).toBe(400);
  });

  it("checkpoint null (fresh) → claim throws CHECKPOINT_PENDING → 409", async () => {
    claimHandoffMock.mockRejectedValue(new HandoffClaimError("CHECKPOINT_PENDING", "not frozen yet"));
    const { nextErr } = await invoke(handler, { params: { id: "run-1" }, body: { provider: "OLLAMA", baseUrl: "http://x:11434/v1" } });
    expect(nextErr?.statusCode).toBe(409);
    expect(enqueueRunMock).not.toHaveBeenCalled();
  });

  it("past the stale threshold → claim succeeds → run RUNNING + enqueue, 200", async () => {
    claimHandoffMock.mockResolvedValue({ id: "hl-1", status: "CLAIMED", toProvider: "OLLAMA" });
    const { res, nextErr } = await invoke(handler, { params: { id: "run-1" }, body: { provider: "OLLAMA", baseUrl: "http://x:11434/v1", model: "gemma3:4b" } });

    expect(nextErr).toBeUndefined();
    expect(claimHandoffMock).toHaveBeenCalledWith(expect.objectContaining({ handoffId: "hl-1", provider: "OLLAMA", model: "gemma3:4b", baseUrl: "http://x:11434/v1" }));
    expect(runUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "RUNNING" } }));
    expect(enqueueRunMock).toHaveBeenCalledWith("run-1");
    expect(res.body).toMatchObject({ success: true, status: "RUNNING", toProvider: "OLLAMA" });
  });

  it("prod keyless-local WITHOUT baseUrl → 400 (B4c)", async () => {
    envMock.NODE_ENV = "production";
    envMock.OFFLINE_MODE = false;
    const { nextErr } = await invoke(handler, { params: { id: "run-1" }, body: { provider: "OLLAMA" } });
    expect(nextErr?.statusCode).toBe(400);
    expect(claimHandoffMock).not.toHaveBeenCalled();
  });

  it("prod keyless-local WITH baseUrl → allowed (claims)", async () => {
    envMock.NODE_ENV = "production";
    const { nextErr } = await invoke(handler, { params: { id: "run-1" }, body: { provider: "OLLAMA", baseUrl: "http://gpu-box:11434/v1" } });
    expect(nextErr).toBeUndefined();
    expect(claimHandoffMock).toHaveBeenCalled();
  });

  it("cloud provider not configured for the tenant → 400", async () => {
    listTenantProviderLinksMock.mockResolvedValue([{ provider: "ANTHROPIC" }]);
    const { nextErr } = await invoke(handler, { params: { id: "run-1" }, body: { provider: "OPENAI" } });
    expect(nextErr?.statusCode).toBe(400);
    expect(claimHandoffMock).not.toHaveBeenCalled();
  });

  it("cloud provider configured → allowed", async () => {
    listTenantProviderLinksMock.mockResolvedValue([{ provider: "OPENAI" }]);
    const { nextErr } = await invoke(handler, { params: { id: "run-1" }, body: { provider: "OPENAI", model: "gpt-4o" } });
    expect(nextErr).toBeUndefined();
    expect(claimHandoffMock).toHaveBeenCalled();
  });
});

// ── GET /:id/handoffs ──

describe("GET /runs/:id/handoffs", () => {
  const handler = getHandler(runRouter, "get", "/:id/handoffs");

  it("unauthorized run → 404", async () => {
    runFindFirst.mockResolvedValue(null);
    const { nextErr } = await invoke(handler, { params: { id: "run-x" } });
    expect(nextErr?.statusCode).toBe(404);
  });

  it("returns the run's ledgers newest-first", async () => {
    runFindFirst.mockResolvedValue({ id: "run-1" });
    handoffFindMany.mockResolvedValue([{ id: "hl-2" }, { id: "hl-1" }]);
    const { res, nextErr } = await invoke(handler, { params: { id: "run-1" } });
    expect(nextErr).toBeUndefined();
    expect(res.body).toMatchObject({ handoffs: [{ id: "hl-2" }, { id: "hl-1" }] });
    expect(handoffFindMany.mock.calls[0][0].orderBy).toMatchObject({ createdAt: "desc" });
  });
});

// ── POST /steps/:id/rerun — ledger guard (B6.3) ──

describe("POST /run-steps/:id/rerun — handoff guard", () => {
  const handler = getHandler(runRouter, "post", "/steps/:id/rerun");

  function stepRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "rs-1", runId: "run-1", stepIndex: 0, status: "FAILED", name: "research",
      input: {},
      run: { pipeline: { company: { tenantId: "tenant-1" }, steps: [] } },
      ...overrides,
    };
  }

  // rerun uses prisma.runStep.findUnique with a rich include — mock it here.
  beforeEach(() => {
    runStepFindUnique.mockResolvedValue(stepRow());
    runStepUpdate.mockResolvedValue({});
  });

  it("CLAIMED ledger on the run → 409 (no rerun while a takeover is in flight)", async () => {
    handoffFindFirst.mockResolvedValue({ id: "hl-1", status: "CLAIMED" });
    const { nextErr } = await invoke(handler, { params: { id: "rs-1" } });
    expect(nextErr?.statusCode).toBe(409);
    expect(cancelOpenHandoffForRunMock).not.toHaveBeenCalled();
  });

  it("OPEN ledger on the run → cancelled, rerun proceeds", async () => {
    handoffFindFirst.mockResolvedValue({ id: "hl-1", status: "OPEN" });
    // Stub the dynamic executeStep import so rerun can proceed past the guard.
    vi.doMock("../../pipeline/executor", () => ({
      executeStep: vi.fn().mockResolvedValue({ status: "COMPLETED" }),
    }));
    await invoke(handler, { params: { id: "rs-1" } });
    expect(cancelOpenHandoffForRunMock).toHaveBeenCalledWith("run-1", "rerun", "user-1");
  });
});

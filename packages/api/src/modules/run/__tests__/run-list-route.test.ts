/**
 * BRA-P0-04b — GET /runs liste ucu: doğrulama, tenant kapsamı, sayfalama,
 * yanıt anahtar sözleşmesi, sızıntı yokluğu.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const findMany = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({ prisma: { run: { findMany: (...a: unknown[]) => findMany(...a) } } }));
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
import { decodeCursor } from "../list-cursor";

function getHandler(router: Router, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()],
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void> | void;
}
const handler = getHandler(runRouter, "get", "/");

async function invoke(query: Record<string, unknown> = {}, tenantId = "tenant-1") {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
  };
  let nextErr: any;
  await handler({ auth: { tenantId, userId: "u", role: "admin" }, query, params: {}, body: {} }, res, (e?: any) => { nextErr = e; });
  return { res, nextErr };
}

const RESPONSE_KEYS = [
  "bucket", "completedAt", "costUsd", "createdAt", "heartbeatAt", "id", "pipeline", "pipelineId",
  "resultStatus", "startedAt", "state", "status", "trigger", "updatedAt",
];

function row(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `run-${i}`,
    pipelineId: "p1",
    status: "RUNNING",
    state: null,
    resultStatus: null,
    trigger: "manual",
    costUsd: null,
    startedAt: null,
    completedAt: null,
    heartbeatAt: null,
    createdAt: new Date(Date.UTC(2026, 10, 9, 10, 0, 60 - i)),
    updatedAt: new Date(Date.UTC(2026, 10, 9, 10, 0, 60 - i)),
    pipeline: { id: "p1", name: "Pipe", company: { id: "c1", name: "Co" } },
    ...over,
  };
}

beforeEach(() => { findMany.mockReset(); findMany.mockResolvedValue([]); });

describe("GET /runs", () => {
  it("/:id'den ÖNCE tanımlı", () => {
    const paths = (runRouter as any).stack.filter((l: any) => l.route).map((l: any) => l.route.path);
    expect(paths.indexOf("/")).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf("/")).toBeLessThan(paths.indexOf("/:id"));
  });

  it.each(["bogus", "ALL", "Working", ""])("geçersiz bucket %j -> 400", async (b) => {
    const { nextErr } = await invoke({ bucket: b });
    expect(nextErr?.statusCode).toBe(400);
    expect(findMany).not.toHaveBeenCalled();
  });

  it.each(["0", "101", "-3", "x", "2.5", ""])("geçersiz limit %j -> 400", async (l) => {
    const { nextErr } = await invoke({ limit: l });
    expect(nextErr?.statusCode).toBe(400);
  });

  it.each(["garbage", "e30", Buffer.from("{}").toString("base64url")])("geçersiz cursor %j -> 400", async (c) => {
    const { nextErr } = await invoke({ cursor: c });
    expect(nextErr?.statusCode).toBe(400);
  });

  it("varsayılan limit 25 (take 26), tenant kapsamı where içinde, sıralama createdAt+id desc", async () => {
    const { res } = await invoke({}, "tenant-A");
    expect(res.body).toEqual({ runs: [], nextCursor: null });
    const arg = findMany.mock.calls[0][0];
    expect(arg.take).toBe(26);
    expect(arg.where.AND[0]).toEqual({ pipeline: { company: { tenantId: "tenant-A" } } });
    expect(arg.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("her bucket değeri kabul edilir; where bucket koşulunu taşır", async () => {
    for (const bucket of ["working", "needs_approval", "done", "stuck"]) {
      findMany.mockClear();
      const { res, nextErr } = await invoke({ bucket });
      expect(nextErr).toBeUndefined();
      expect(res.statusCode).toBe(200);
      expect(findMany.mock.calls[0][0].where.AND).toHaveLength(2);
    }
  });

  it("kenar: başka kiracı aynı where ile sorgulanır, tenantId farklıdır", async () => {
    await invoke({}, "tenant-A");
    await invoke({}, "tenant-B");
    expect(findMany.mock.calls[0][0].where.AND[0]).not.toEqual(findMany.mock.calls[1][0].where.AND[0]);
  });

  it("yanıt anahtar seti kilitli; bucket jobBucket ile hesaplanır; sızıntı yok", async () => {
    findMany.mockResolvedValue([
      row(1, { state: "NEEDS_APPROVAL", status: "WAITING_APPROVAL" }),
      row(2, { state: "RUNNING", heartbeatAt: new Date(Date.now() - 3600_000) }), // bayat
      row(3, { state: null, status: "COMPLETED" }),
    ]);
    const { res } = await invoke({ limit: "10" });
    const runs = res.body.runs;
    expect(runs.map((r: any) => r.bucket)).toEqual(["needs_approval", "stuck", "done"]);
    for (const r of runs) expect(Object.keys(r).sort()).toEqual(RESPONSE_KEYS);
    expect(Object.keys(runs[0].pipeline.company).sort()).toEqual(["id", "name"]);
    const text = JSON.stringify(res.body);
    for (const leak of ["config", "webhookSecret", "input", "output", "error"]) expect(text).not.toContain(`"${leak}"`);
    // select açık ve dar
    const sel = findMany.mock.calls[0][0].select;
    expect(Object.keys(sel).sort()).toEqual(RESPONSE_KEYS.filter((k) => k !== "bucket"));
    expect(findMany.mock.calls[0][0].include).toBeUndefined();
  });

  it("sayfalama: limit+1 satırda nextCursor son SAYFA satırından; imleç sonraki where'e girer; son sayfada null", async () => {
    findMany.mockResolvedValue([row(1), row(2), row(3)]);
    const first = await invoke({ limit: "2" });
    expect(first.res.body.runs.map((r: any) => r.id)).toEqual(["run-1", "run-2"]);
    const cur = decodeCursor(first.res.body.nextCursor);
    expect(cur).toEqual({ createdAt: row(2).createdAt, id: "run-2" });

    findMany.mockClear();
    findMany.mockResolvedValue([row(3)]);
    const second = await invoke({ limit: "2", cursor: first.res.body.nextCursor });
    expect(second.res.body.nextCursor).toBeNull();
    expect(second.res.body.runs.map((r: any) => r.id)).toEqual(["run-3"]);
    const where = findMany.mock.calls[0][0].where.AND;
    expect(where[where.length - 1]).toEqual({
      OR: [{ createdAt: { lt: cur!.createdAt } }, { createdAt: cur!.createdAt, id: { lt: "run-2" } }],
    });
  });

  it("tam limit kadar satır: nextCursor null", async () => {
    findMany.mockResolvedValue([row(1), row(2)]);
    const { res } = await invoke({ limit: "2" });
    expect(res.body.nextCursor).toBeNull();
  });
});

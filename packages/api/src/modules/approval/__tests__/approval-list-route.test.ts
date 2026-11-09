/**
 * BRA-P0-04b — GET /approvals: status doğrulaması, geriye uyum (düz dizi),
 * sayfalama (X-Next-Cursor), groupBy=run, tenant kapsamı, sızıntı yokluğu.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

const approvalFindMany = vi.hoisted(() => vi.fn());
const runFindMany = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: {
    approval: { findMany: (...a: unknown[]) => approvalFindMany(...a) },
    run: { findMany: (...a: unknown[]) => runFindMany(...a) },
    draft: { findFirst: vi.fn().mockResolvedValue(null) },
  },
  tenantTx: vi.fn(),
}));
vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../middleware/require-permission", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../pipeline/runner", () => ({ enqueueRun: vi.fn() }));
vi.mock("../../external/control", () => ({ runControlAction: vi.fn() }));
vi.mock("../../../config/env", () => ({ env: { NODE_ENV: "test", OFFLINE_MODE: false } }));

import { approvalRouter } from "../router";
import { decodeCursor } from "../../run/list-cursor";

function getHandler(router: Router, path: string) {
  const layer = (router as any).stack.find((l: any) => l.route && l.route.path === path && l.route.methods.get);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void>;
}
const handler = getHandler(approvalRouter, "/");

async function invoke(query: Record<string, unknown> = {}, tenantId = "tenant-1") {
  const headers: Record<string, string> = {};
  const res: any = {
    statusCode: 200,
    body: undefined,
    setHeader(k: string, v: string) { headers[k] = v; },
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
  };
  let nextErr: any;
  await handler({ auth: { tenantId, userId: "u", role: "admin" }, query }, res, (e?: any) => { nextErr = e; });
  return { res, headers, nextErr };
}

function ap(i: number, runId = `run-${i}`) {
  const t = new Date(Date.UTC(2026, 10, 9, 10, 0, 60 - i));
  return {
    id: `ap-${i}`, runId, type: "SPEND", status: "PENDING", description: "d", metadata: {}, createdAt: t,
    run: { id: runId, pipeline: { id: "p", name: `Pipe ${runId}`, company: { id: "c", name: "Co", config: { webhookSecret: "SECRET" } } } },
  };
}

beforeEach(() => {
  approvalFindMany.mockReset();
  runFindMany.mockReset();
  runFindMany.mockResolvedValue([]);
  approvalFindMany.mockResolvedValue([]);
});

describe("GET /approvals", () => {
  it.each(["bogus", "pending", "ALL", ""])("geçersiz status %j -> 400", async (s) => {
    const { nextErr } = await invoke({ status: s });
    expect(nextErr?.statusCode).toBe(400);
    expect(approvalFindMany).not.toHaveBeenCalled();
  });

  it.each(["PENDING", "APPROVED", "REJECTED", "EXPIRED"])("status %s geçerli", async (s) => {
    const { nextErr } = await invoke({ status: s });
    expect(nextErr).toBeUndefined();
    expect(approvalFindMany.mock.calls[0][0].where.status).toBe(s);
  });

  it("geçersiz limit / cursor / groupBy -> 400", async () => {
    for (const q of [{ limit: "0" }, { limit: "101" }, { limit: "x" }, { cursor: "zzz" }, { groupBy: "company" }]) {
      const { nextErr } = await invoke(q);
      expect(nextErr?.statusCode, JSON.stringify(q)).toBe(400);
    }
  });

  it("geriye uyum: parametresiz = düz dizi, varsayılan PENDING, sayfalama/take YOK, başlık yok, sızıntı yok", async () => {
    approvalFindMany.mockResolvedValue([ap(1), ap(2), ap(3)]);
    const { res, headers } = await invoke();
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.map((a: any) => a.id)).toEqual(["ap-1", "ap-2", "ap-3"]);
    expect(res.body[0]).toHaveProperty("artifact");
    expect(res.body[0].run.pipeline.company.config).toEqual({ webhookSecretSet: true });
    expect(JSON.stringify(res.body)).not.toContain("SECRET");
    expect(headers["X-Next-Cursor"]).toBeUndefined();
    const arg = approvalFindMany.mock.calls[0][0];
    expect(arg.take).toBeUndefined();
    expect(arg.where).toEqual({
      run: { pipeline: { company: { tenantId: "tenant-1" } } },
      status: "PENDING",
    });
  });

  it("tenant izolasyonu: where her zaman çağıran kiracıyı taşır", async () => {
    await invoke({ limit: "5" }, "tenant-X");
    expect(approvalFindMany.mock.calls[0][0].where.run).toEqual({ pipeline: { company: { tenantId: "tenant-X" } } });
  });

  it("limit: gövde dizi kalır, imleç X-Next-Cursor başlığında; son sayfada başlık yok", async () => {
    approvalFindMany.mockResolvedValue([ap(1), ap(2), ap(3)]);
    const first = await invoke({ limit: "2" });
    expect(Array.isArray(first.res.body)).toBe(true);
    expect(first.res.body).toHaveLength(2);
    expect(approvalFindMany.mock.calls[0][0].take).toBe(3);
    const cur = decodeCursor(first.headers["X-Next-Cursor"]);
    expect(cur).toEqual({ createdAt: ap(2).createdAt, id: "ap-2" });

    approvalFindMany.mockClear();
    approvalFindMany.mockResolvedValue([ap(3)]);
    const second = await invoke({ limit: "2", cursor: first.headers["X-Next-Cursor"] });
    expect(second.headers["X-Next-Cursor"]).toBeUndefined();
    expect(second.res.body.map((a: any) => a.id)).toEqual(["ap-3"]);
    expect(approvalFindMany.mock.calls[0][0].where.AND).toHaveLength(1);
  });

  it("groupBy=run: aynı koşunun onayları grup halinde; runTitle; nextCursor gövdede; run tekrarlanmaz", async () => {
    approvalFindMany.mockResolvedValue([ap(1, "run-A"), ap(2, "run-B"), ap(3, "run-A")]);
    const { res } = await invoke({ groupBy: "run" });
    expect(Object.keys(res.body).sort()).toEqual(["groups", "nextCursor"]);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.groups.map((g: any) => g.runId)).toEqual(["run-A", "run-B"]);
    expect(res.body.groups[0].runTitle).toBe("Pipe run-A");
    expect(res.body.groups[0].approvals.map((a: any) => a.id)).toEqual(["ap-1", "ap-3"]);
    expect(res.body.groups[0].approvals[0]).not.toHaveProperty("run");
    expect(JSON.stringify(res.body)).not.toContain("SECRET");
  });

  it("groupBy=run + limit: nextCursor gövdede", async () => {
    approvalFindMany.mockResolvedValue([ap(1, "run-A"), ap(2, "run-A"), ap(3, "run-B")]);
    const { res } = await invoke({ groupBy: "run", limit: "2" });
    expect(res.body.groups).toHaveLength(1);
    expect(decodeCursor(res.body.nextCursor)?.id).toBe("ap-2");
  });
});

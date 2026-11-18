/**
 * BRA-P1-08-N3 — web ve mobil için TEK DURUM KAYNAĞI sözleşmesi (platform tarafı).
 *  1. durum enum'ları (JobState / RunStatus / ResultStatus / InboxBucket) Prisma ↔ core birebir
 *  2. GET /runs: her JOB_STATE ve her eski status için API'nin döndürdüğü kova == core jobBucket (tek kaynak)
 *  3. GET /runs ve GET /runs/:id: istemcinin okuduğu ZORUNLU anahtar kümesi kilitli; yanıt yalnız genişleyebilir
 *  4. POST /runs/:id/steer: kiracı dışı 404, bitmiş koşu 400, canlı durumlar 201
 * Zaten kilitli olanlar tekrarlanmaz: tam anahtar eşitliği (run-list-route, run-detail-contract,
 * approval-list-contract), stop/pause/resume geçişleri (operator-routes), SQL ↔ jobBucket (job-bucket-query).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";
import { Prisma, JobState, RunStatus, ResultStatus } from "@prisma/client";
import {
  INBOX_BUCKETS, JOB_STATES, LEGACY_RUN_STATUS_VALUES, RESULT_STATUSES, jobBucket,
} from "@ai-company-os/core";

vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const findMany = vi.hoisted(() => vi.fn());
const count = vi.hoisted(() => vi.fn());
const findFirst = vi.hoisted(() => vi.fn());
const findUnique = vi.hoisted(() => vi.fn());
const steerCreate = vi.hoisted(() => vi.fn());
const logCreate = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: {
    run: {
      findMany: (...a: unknown[]) => findMany(...a),
      count: (...a: unknown[]) => count(...a),
      findFirst: (...a: unknown[]) => findFirst(...a),
      findUnique: (...a: unknown[]) => findUnique(...a),
    },
    steeringMessage: { create: (...a: unknown[]) => steerCreate(...a) },
    activityLog: { create: (...a: unknown[]) => logCreate(...a) },
  },
}));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: (_q: unknown, _s: unknown, next: () => void) => next() }));
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => (_q: unknown, _s: unknown, next: () => void) => next() }));
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
  createHandoff: vi.fn(), claimHandoff: vi.fn(), cancelOpenHandoffForRun: vi.fn(),
  HandoffClaimError: class HandoffClaimError extends Error {},
}));
vi.mock("../../../config/env", () => ({ env: { NODE_ENV: "development", OFFLINE_MODE: false, CLAUDE_MODEL: "claude-sonnet-4-5" } }));

import { runRouter } from "../router";

function getHandler(method: string, path: string) {
  const layer = (runRouter as Router as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`No route ${method} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void>;
}
async function call(h: ReturnType<typeof getHandler>, req: Record<string, unknown>, tenantId = "tenant-1") {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let nextErr: any;
  await h({ auth: { tenantId, userId: "u-1", role: "admin" }, params: {}, query: {}, body: {}, ...req }, res, (e?: any) => { nextErr = e; });
  return { res, nextErr };
}

/** Mobil ve web istemcisinin gelen kutusunda okuduğu asgari alanlar; yanıt bunların ÜST KÜMESİ olmalı. */
const LIST_REQUIRED = ["id", "pipelineId", "status", "state", "resultStatus", "bucket", "createdAt", "pipeline"];
const DETAIL_REQUIRED = ["id", "status", "state", "resultStatus", "steps", "approvals", "pipeline", "createdAt"];

function listRow(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `run-${i}`, pipelineId: "p1", status: "RUNNING", state: null, resultStatus: null, trigger: "manual", costUsd: null,
    startedAt: null, completedAt: null, heartbeatAt: null,
    createdAt: new Date(Date.UTC(2026, 10, 9, 10, 0, 60 - i)), updatedAt: new Date(Date.UTC(2026, 10, 9, 10, 0, 60 - i)),
    pipeline: { id: "p1", name: "Pipe", company: { id: "c1", name: "Co" } },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  count.mockResolvedValue(0);
});

describe("durum enum sözleşmesi (Prisma ↔ core)", () => {
  it("JobState / RunStatus / ResultStatus Prisma ile core'da birebir; kovalar sabit", () => {
    expect([...Object.values(JobState)].sort()).toEqual([...JOB_STATES].sort());
    expect([...Object.values(RunStatus)].sort()).toEqual([...LEGACY_RUN_STATUS_VALUES].sort());
    expect([...Object.values(ResultStatus)].sort()).toEqual([...RESULT_STATUSES].sort());
    expect([...INBOX_BUCKETS]).toEqual(["working", "needs_approval", "done", "stuck"]);
  });
});

describe("GET /runs — kova tek kaynaktan (jobBucket)", () => {
  const h = getHandler("get", "/");

  it("her JOB_STATE (eski status her değerde) için API kovası == jobBucket; kova daima kümede ya da null", async () => {
    const rows: Array<Record<string, unknown>> = [];
    let i = 0;
    for (const state of [...JOB_STATES, null]) {
      for (const status of LEGACY_RUN_STATUS_VALUES) rows.push(listRow(i++, { state, status }));
    }
    findMany.mockResolvedValue(rows);
    const { res } = await call(h, { query: { limit: "100" } });
    expect(res.body.runs).toHaveLength(rows.length);
    const now = new Date();
    for (const [idx, r] of res.body.runs.entries()) {
      const src = rows[idx];
      const expected = jobBucket({ state: src.state as string | null, status: src.status as string, resultStatus: null, heartbeatAt: null, now, staleAfterMs: 15 * 60_000 });
      expect(r.bucket, `${src.state}/${src.status}`).toBe(expected);
      expect(r.bucket === null || (INBOX_BUCKETS as readonly string[]).includes(r.bucket)).toBe(true);
    }
    // DRAFT gelen kutusunda görünmez (null), diğer 9 durum bir kovaya düşer
    const byState = new Map(res.body.runs.map((r: any) => [r.state, r.bucket]));
    expect(byState.get("DRAFT")).toBeNull();
    for (const s of JOB_STATES.filter((x) => x !== "DRAFT")) expect(byState.get(s)).not.toBeNull();
  });

  it("zorunlu alan kümesi kilitli; yanıta eklenen bilinmeyen alan istemciyi kırmaz (üst küme)", async () => {
    findMany.mockResolvedValue([listRow(1, { futureField: { x: 1 } })]);
    const { res } = await call(h, {});
    const r = res.body.runs[0];
    for (const k of LIST_REQUIRED) expect(r, k).toHaveProperty(k);
    expect(Object.keys(res.body).sort()).toEqual(["nextCursor", "runs"]);
    // ileri sürüm: tanınmayan state yok sayılıp iş gizlenmez
    findMany.mockResolvedValue([listRow(2, { state: "FUTURE_STATE" })]);
    expect((await call(h, {})).res.body.runs[0].bucket).toBe("stuck");
  });
});

describe("GET /runs/:id — zorunlu alanlar ve kiracı", () => {
  const h = getHandler("get", "/:id");
  const full = (tenantId: string) => {
    const row: Record<string, unknown> = {};
    for (const k of Object.values(Prisma.RunScalarFieldEnum)) row[k] = null;
    return { ...row, futureField: 1, steps: [], approvals: [], pipeline: { id: "p", company: { id: "c", tenantId, config: {} } } };
  };

  it("zorunlu alanlar mevcut; ek alanlar geçer (yalnız eklenir)", async () => {
    findUnique.mockResolvedValue(full("tenant-1"));
    const { res } = await call(h, { params: { id: "run-1" } });
    for (const k of DETAIL_REQUIRED) expect(res.body, k).toHaveProperty(k);
  });

  it("başka kiracının koşusu → 404", async () => {
    findUnique.mockResolvedValue(full("tenant-2"));
    const { nextErr, res } = await call(h, { params: { id: "run-1" } });
    expect(nextErr?.statusCode).toBe(404);
    expect(res.body).toBeUndefined();
  });
});

describe("POST /runs/:id/steer — geçişler", () => {
  const h = getHandler("post", "/:id/steer");
  beforeEach(() => {
    steerCreate.mockResolvedValue({ id: "sm-1" });
    logCreate.mockResolvedValue({});
  });

  it("kiracı kapsamı where içinde; başka kiracının koşusu → 404, yazma yok", async () => {
    findFirst.mockResolvedValue(null);
    const { nextErr } = await call(h, { params: { id: "run-1" }, body: { content: "dur" } }, "tenant-9");
    expect(nextErr?.statusCode).toBe(404);
    expect(findFirst.mock.calls[0][0].where).toEqual({ id: "run-1", pipeline: { company: { tenantId: "tenant-9" } } });
    expect(steerCreate).not.toHaveBeenCalled();
    expect(logCreate).not.toHaveBeenCalled();
  });

  it.each(["COMPLETED", "FAILED", "CANCELLED"])("bitmiş koşu (%s) → 400, yazma yok", async (status) => {
    findFirst.mockResolvedValue({ id: "run-1", status });
    const { nextErr } = await call(h, { params: { id: "run-1" }, body: { content: "x" } });
    expect(nextErr?.statusCode).toBe(400);
    expect(steerCreate).not.toHaveBeenCalled();
  });

  it.each(["PENDING", "RUNNING", "PAUSED", "WAITING_APPROVAL"])("canlı koşu (%s) → 201 + {success,id}; durum değişmez", async (status) => {
    findFirst.mockResolvedValue({ id: "run-1", status });
    const { res, nextErr } = await call(h, { params: { id: "run-1" }, body: { content: " yönlendir " } });
    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ success: true, id: "sm-1" });
    expect(steerCreate.mock.calls[0][0].data).toMatchObject({ runId: "run-1", kind: "STEER", content: "yönlendir" });
    expect(logCreate).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { content: "   " }, { content: 5 }])("boş/geçersiz içerik %j → 400, koşu okunmaz", async (body) => {
    const { nextErr } = await call(h, { params: { id: "run-1" }, body });
    expect(nextErr?.statusCode).toBe(400);
    expect(findFirst).not.toHaveBeenCalled();
  });
});

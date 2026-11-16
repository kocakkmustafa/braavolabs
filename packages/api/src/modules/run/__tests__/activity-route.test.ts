/** BRA-P2-05 — GET /runs/:id/activity: tenant, sayfalama/imleç, limit, sızıntı, boş koşu, etiket eşlemesi, sıralama. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const runFindFirst = vi.hoisted(() => vi.fn());
const logFindMany = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: { run: { findFirst: (...a: unknown[]) => runFindFirst(...a) }, activityLog: { findMany: (...a: unknown[]) => logFindMany(...a) } },
}));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: (_q: unknown, _r: unknown, n: () => void) => n() }));
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => (_q: unknown, _r: unknown, n: () => void) => n() }));
vi.mock("../../pipeline/runner", () => ({ enqueueRun: vi.fn() }));
vi.mock("../../../services/ai-client", async (o) => ({ ...(await o<typeof import("../../../services/ai-client")>()), chatCompletion: vi.fn() }));
vi.mock("../../../services/provider-chain", async (o) => ({ ...(await o<typeof import("../../../services/provider-chain")>()), listTenantProviderLinks: vi.fn().mockResolvedValue([]) }));
vi.mock("../../../services/takeover-config", () => ({ assertKeylessLocalBaseUrl: vi.fn() }));
vi.mock("../handoff.service", () => ({
  createHandoff: vi.fn(), claimHandoff: vi.fn(), cancelOpenHandoffForRun: vi.fn(),
  HandoffClaimError: class HandoffClaimError extends Error {},
}));
vi.mock("../../../config/env", () => ({ env: { NODE_ENV: "development", OFFLINE_MODE: false, CLAUDE_MODEL: "claude-sonnet-4-5" } }));

import { runRouter } from "../router";
import { decodeCursor, encodeCursor } from "../list-cursor";
import { ACTION_LABELS, actionLabel, safeActor, summarize, toActivityItem } from "../activity";

const layer = (runRouter as Router as any).stack.find((l: any) => l.route?.path === "/:id/activity" && l.route.methods.get);
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

async function call(query: Record<string, unknown> = {}, tenantId = "t1") {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let err: any;
  await handler({ auth: { tenantId, userId: "u", role: "admin" }, params: { id: "run-1" }, query, body: {} }, res, (e?: any) => { err = e; });
  return { res, err };
}
const row = (id: string, sec: number, over: Record<string, unknown> = {}) => ({
  id, action: "run.stop", actor: "cmabcdefghijklmnopqrstuvw", details: {}, createdAt: new Date(Date.UTC(2026, 10, 16, 10, 0, sec)), ...over,
});
const RUN = { id: "run-1", steps: [{ id: "st1" }, { id: "st2" }], approvals: [{ id: "ap1" }] };
beforeEach(() => { vi.clearAllMocks(); runFindFirst.mockResolvedValue(RUN); logFindMany.mockResolvedValue([]); });

describe("GET /runs/:id/activity", () => {
  it("route-marker: uç mevcut runRouter içinde, router düzeyinde authMiddleware altında", () => {
    expect(layer).toBeTruthy();
  });
  it("yabancı kiracı → 404; günlük sorgulanmaz; koşu sorgusu tenant'a bağlı", async () => {
    runFindFirst.mockResolvedValue(null);
    const { err } = await call({}, "t2");
    expect(err?.statusCode).toBe(404);
    expect(runFindFirst.mock.calls[0][0].where).toEqual({ id: "run-1", pipeline: { company: { tenantId: "t2" } } });
    expect(logFindMany).not.toHaveBeenCalled();
  });
  it("günlük sorgusunda tenantId her zaman where içinde (silinirse düşer)", async () => {
    await call();
    const where = logFindMany.mock.calls[0][0].where;
    expect(where.AND[0]).toEqual({ tenantId: "t1" });
    expect(JSON.stringify(where)).toContain('"tenantId":"t1"');
  });
  it("koşu + adım + onay bağları ve approval.requested yol eşitliği sorguya girer", async () => {
    await call();
    const or = logFindMany.mock.calls[0][0].where.AND[1].OR;
    expect(or).toContainEqual({ resource: "run", resourceId: "run-1" });
    expect(or).toContainEqual({ resource: "run_step", resourceId: { in: ["st1", "st2"] } });
    expect(or).toContainEqual({ resource: "approval", resourceId: { in: ["ap1"] } });
    expect(or).toContainEqual({ action: "approval.requested", resource: "run_step", details: { path: ["runId"], equals: "run-1" } });
  });
  it("boş koşu (adım/onay yok): yalnız koşu ve requested bağı; yanıt boş, nextCursor null", async () => {
    runFindFirst.mockResolvedValue({ id: "run-1", steps: [], approvals: [] });
    const { res } = await call();
    expect(res.body).toEqual({ items: [], nextCursor: null });
    expect(logFindMany.mock.calls[0][0].where.AND[1].OR).toHaveLength(2);
  });
  it("yanıt kalemi biçimi: {id, action, at, actor, summary}; başka anahtar yok", async () => {
    logFindMany.mockResolvedValue([row("a1", 5)]);
    const { res } = await call();
    expect(res.body.items).toEqual([{ id: "a1", action: "run.stop", at: "2026-11-16T10:00:05.000Z", actor: "cmabcdefghijklmnopqrstuvw", summary: "Run stopped" }]);
    expect(Object.keys(res.body)).toEqual(["items", "nextCursor"]);
  });
  it("sayfalama: limit+1 çekilir, fazlası kırpılır, imleç son kalemden (createdAt+id)", async () => {
    logFindMany.mockResolvedValue([row("c", 3), row("b", 2), row("a", 1)]);
    const { res } = await call({ limit: "2" });
    expect(logFindMany.mock.calls[0][0].take).toBe(3);
    expect(res.body.items.map((i: any) => i.id)).toEqual(["c", "b"]);
    expect(decodeCursor(res.body.nextCursor)).toEqual({ createdAt: new Date(Date.UTC(2026, 10, 16, 10, 0, 2)), id: "b" });
  });
  it("son sayfa: nextCursor null", async () => {
    logFindMany.mockResolvedValue([row("a", 1)]);
    expect((await call({ limit: "2" })).res.body.nextCursor).toBeNull();
  });
  it("imleç where'e (createdAt lt | eşit+id lt) eklenir", async () => {
    const cursor = encodeCursor({ createdAt: new Date("2026-11-16T10:00:02.000Z"), id: "b" });
    await call({ cursor });
    const and = logFindMany.mock.calls[0][0].where.AND;
    expect(and[2]).toEqual({ OR: [{ createdAt: { lt: new Date("2026-11-16T10:00:02.000Z") } }, { createdAt: new Date("2026-11-16T10:00:02.000Z"), id: { lt: "b" } }] });
  });
  it("bozuk imleç → 400; run sorgulanmaz", async () => {
    const { err } = await call({ cursor: "zzz" });
    expect(err?.statusCode).toBe(400);
    expect(runFindFirst).not.toHaveBeenCalled();
  });
  it("limit: varsayılan 50; 100 geçerli; 101/0/abc → 400", async () => {
    await call();
    expect(logFindMany.mock.calls[0][0].take).toBe(51);
    await call({ limit: "100" });
    expect(logFindMany.mock.calls[1][0].take).toBe(101);
    for (const l of ["101", "0", "abc", "-1"]) expect((await call({ limit: l })).err?.statusCode).toBe(400);
  });
  it("sıralama kararlı: createdAt desc + id desc", async () => {
    await call();
    expect(logFindMany.mock.calls[0][0].orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });
  it("sızıntı: sır/uzun/ham içerik içeren details summary'ye girmez; select'te yalnız dar alanlar", async () => {
    const SECRET = "sk-ant-api03-SUPERSECRETTOKEN";
    logFindMany.mockResolvedValue([
      row("x1", 9, { action: "run.hierarchical_failed", details: { error: SECRET, cause: "job_budget", reasoning: SECRET, email: "a@b.com", output: "x".repeat(5000) } }),
      row("x2", 8, { action: "run.steer", actor: "alice@example.com", details: { message: SECRET, targetAgentId: SECRET } }),
      row("x3", 7, { action: `evil ${SECRET}`, actor: "sk-ant-api03-SUPERSECRETTOKEN" }),
      row("x4", 6, { action: "run_step.rerun", details: { result: SECRET, stepIndex: "<script>" } }),
    ]);
    const { res } = await call();
    const s = JSON.stringify(res.body);
    for (const bad of [SECRET, "a@b.com", "alice@example.com", "xxxxx", "<script>", "reasoning"]) expect(s).not.toContain(bad);
    expect(res.body.items[0].summary).toBe("Run failed · budget limit");
    expect(res.body.items[1]).not.toHaveProperty("actor");
    expect(res.body.items[2]).toMatchObject({ action: "unknown", summary: "Event" });
    expect(Object.keys(logFindMany.mock.calls[0][0].select).sort()).toEqual(["action", "actor", "createdAt", "details", "id"]);
  });
});

describe("activity.ts saf yardımcılar", () => {
  it("bilinen eylemlerin tümü sabit etikete eşlenir; bilinmeyen kod-biçimli → Event (action)", () => {
    for (const [a, l] of Object.entries(ACTION_LABELS)) expect(actionLabel(a)).toBe(l);
    expect(actionLabel("billing.something")).toBe("Event (billing.something)");
    expect(actionLabel("toString")).toBe("Event");
    expect(actionLabel(42)).toBe("Event");
  });
  it("summary ekleri yalnız allowlist: adım (1 tabanlı), deneme, bayraklar, sonuç enum", () => {
    expect(summarize("approval.requested", { gate: "step", stepIndex: 1, approvalId: "x", step: "gizli ad" })).toBe("Approval requested · step 2 · step gate");
    expect(summarize("run.retry", { from: "FAILED", retryCount: 3 })).toBe("Run retried · attempt 3");
    expect(summarize("approval.approved", { runCancelled: true })).toBe("Approval approved · run cancelled");
    expect(summarize("run_step.rerun", { result: "FAILED" })).toBe("Step rerun · result failed");
    expect(summarize("run.stop", null)).toBe("Run stopped");
    expect(summarize("run.stop", [1, 2])).toBe("Run stopped");
    expect(summarize("run.retry", { retryCount: 1e9 })).toBe("Run retried");
  });
  it("actor: system, kimlik biçimli id; e-posta/token-benzeri/kısa/uzun → yok", () => {
    expect(safeActor("system")).toBe("system");
    expect(safeActor("clx1234567890abcdef")).toBe("clx1234567890abcdef");
    for (const bad of ["a@b.com", "sk-abcdefgh1234", "x", "a".repeat(41), 5, null, "has space 12345"]) expect(safeActor(bad)).toBeUndefined();
  });
  it("toActivityItem: actor yoksa anahtar hiç yok", () => {
    expect(toActivityItem({ id: "i", action: "run.stop", actor: "a@b.c", details: {}, createdAt: new Date(0) })).toEqual({ id: "i", action: "run.stop", at: "1970-01-01T00:00:00.000Z", summary: "Run stopped" });
  });
});

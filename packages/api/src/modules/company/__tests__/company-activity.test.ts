/** BRA-P2-03c — GET /companies/:id/activity-feed: tenant, sayfalama, limit/imleç 400, sızıntı, route-marker. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const coFindFirst = vi.hoisted(() => vi.fn());
const logFindMany = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: { company: { findFirst: (...a: unknown[]) => coFindFirst(...a) }, activityLog: { findMany: (...a: unknown[]) => logFindMany(...a) } },
  tenantTx: vi.fn(),
}));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: (_q: unknown, _r: unknown, n: () => void) => n() }));
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => (_q: unknown, _r: unknown, n: () => void) => n() }));
vi.mock("../../../config/env", () => ({ env: { NODE_ENV: "development", OFFLINE_MODE: false, CLAUDE_MODEL: "claude-sonnet-4-5" } }));

import { companyRouter } from "../router";
import { decodeCursor, encodeCursor } from "../../run/list-cursor";
import { COMPANY_ACTION_LABELS, summarizeCompany } from "../activity";

const layers = (companyRouter as Router as any).stack.filter((l: any) => l.route?.path === "/:id/activity-feed" && l.route.methods.get);
const handler = layers[0].route.stack[layers[0].route.stack.length - 1].handle;

async function call(query: Record<string, unknown> = {}, tenantId = "t1", h: any = handler) {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let err: any;
  await h({ auth: { tenantId, userId: "u", role: "MEMBER" }, params: { id: "co-1" }, query, body: {} }, res, (e?: any) => { err = e; });
  return { res, err };
}
const row = (id: string, sec: number, over: Record<string, unknown> = {}) => ({
  id, action: "company.pause", actor: "cmabcdefghijklmnopqrstuvw", details: {}, createdAt: new Date(Date.UTC(2026, 10, 16, 10, 0, sec)), ...over,
});
beforeEach(() => { vi.clearAllMocks(); coFindFirst.mockResolvedValue({ id: "co-1" }); logFindMany.mockResolvedValue([]); });

describe("GET /companies/:id/activity-feed", () => {
  it("tek kayıtlı uç; eski /:id/activity ayrıca durur", () => { expect(layers).toHaveLength(1); });
  it("yabancı kiracı/şirket → 404; günlük sorgulanmaz; şirket sorgusu tenant'a bağlı", async () => {
    coFindFirst.mockResolvedValue(null);
    const { err } = await call({}, "t2");
    expect(err?.statusCode).toBe(404);
    expect(coFindFirst.mock.calls[0][0].where).toEqual({ id: "co-1", tenantId: "t2" });
    expect(logFindMany).not.toHaveBeenCalled();
  });
  it("günlük where: tenantId + resourceId (resource şartı yok); JSON-path yok", async () => {
    await call();
    const where = logFindMany.mock.calls[0][0].where;
    expect(where.AND[0]).toEqual({ tenantId: "t1" });
    expect(where.AND[1]).toEqual({ resourceId: "co-1" });
    expect(JSON.stringify(where)).not.toContain("path");
  });
  it("yanıt biçimi {items:[{id,action,at,actor,summary}], nextCursor}; başka anahtar yok", async () => {
    logFindMany.mockResolvedValue([row("a1", 5)]);
    const { res } = await call();
    expect(res.body).toEqual({ items: [{ id: "a1", action: "company.pause", at: "2026-11-16T10:00:05.000Z", actor: "cmabcdefghijklmnopqrstuvw", summary: "Company paused" }], nextCursor: null });
  });
  it("sayfalama: limit+1, kırpma, imleç son kalemden; imleç where'e girer", async () => {
    logFindMany.mockResolvedValue([row("c", 3), row("b", 2), row("a", 1)]);
    const { res } = await call({ limit: "2" });
    expect(logFindMany.mock.calls[0][0].take).toBe(3);
    expect(res.body.items.map((i: any) => i.id)).toEqual(["c", "b"]);
    expect(decodeCursor(res.body.nextCursor)).toEqual({ createdAt: new Date(Date.UTC(2026, 10, 16, 10, 0, 2)), id: "b" });
    expect(logFindMany.mock.calls[0][0].orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    const cursor = encodeCursor({ createdAt: new Date("2026-11-16T10:00:02.000Z"), id: "b" });
    await call({ cursor });
    expect(logFindMany.mock.calls[1][0].where.AND[2]).toEqual({ OR: [{ createdAt: { lt: new Date("2026-11-16T10:00:02.000Z") } }, { createdAt: new Date("2026-11-16T10:00:02.000Z"), id: { lt: "b" } }] });
  });
  it("limit: varsayılan 50, 100 geçerli; 101/0/abc → 400; bozuk imleç → 400 (şirket sorgulanmaz)", async () => {
    await call();
    expect(logFindMany.mock.calls[0][0].take).toBe(51);
    await call({ limit: "100" });
    expect(logFindMany.mock.calls[1][0].take).toBe(101);
    for (const l of ["101", "0", "abc", "-1"]) expect((await call({ limit: l })).err?.statusCode).toBe(400);
    coFindFirst.mockClear();
    expect((await call({ cursor: "zzz" })).err?.statusCode).toBe(400);
    expect(coFindFirst).not.toHaveBeenCalled();
  });
  it("offset verilirse 400; veri sorgulanmaz", async () => {
    expect((await call({ offset: "5" })).err?.statusCode).toBe(400);
    expect(coFindFirst).not.toHaveBeenCalled();
    expect(logFindMany).not.toHaveBeenCalled();
  });
  it("webhook.* gibi allowlist dışı eylem kaybolmaz: 'Event (action)'", async () => {
    logFindMany.mockResolvedValue([row("w1", 4, { action: "webhook.received", actor: "system", details: { payload: "secret-body" } })]);
    const { res } = await call();
    expect(res.body.items[0]).toMatchObject({ action: "webhook.received", actor: "system", summary: "Event (webhook.received)" });
    expect(JSON.stringify(res.body)).not.toContain("secret-body");
  });
  it("ESKİ /:id/activity sözleşmesi değişmedi: {logs,total,limit,offset}, ham satır", async () => {
    const old = (companyRouter as Router as any).stack.find((l: any) => l.route?.path === "/:id/activity" && l.route.methods.get);
    const h = old.route.stack[old.route.stack.length - 1].handle;
    const rows = [{ id: "r1", action: "x", payload: "raw", details: { a: 1 } }];
    (coFindFirst as any).mockResolvedValue({ id: "co-1" });
    logFindMany.mockResolvedValue(rows);
    const cnt = vi.fn().mockResolvedValue(7);
    const { prisma } = await import("../../../lib/db");
    (prisma as any).activityLog.count = cnt;
    const { res } = await call({ limit: "10", offset: "3" }, "t1", h);
    expect(res.body).toEqual({ logs: rows, total: 7, limit: 10, offset: 3 });
    expect(logFindMany.mock.calls[0][0]).toMatchObject({ where: { tenantId: "t1", resourceId: "co-1" }, orderBy: { createdAt: "desc" }, take: 10, skip: 3 });
  });
  it("sızıntı: e-posta/sır/ham details/ad summary ve yanıta girmez; yalnız rol enum'u ek olur", async () => {
    const SECRET = "sk-ant-api03-SUPERSECRETTOKEN";
    logFindMany.mockResolvedValue([
      row("x1", 9, { action: "company.member.role_update", details: { userId: "u2", from: "MEMBER", to: "ADMIN", email: "a@b.com", note: SECRET } }),
      row("x2", 8, { action: "company.update", actor: "alice@example.com", details: { name: SECRET, config: { apiKey: SECRET }, output: "x".repeat(5000) } }),
      row("x3", 7, { action: `evil ${SECRET}`, actor: SECRET }),
      row("x4", 6, { action: "company.member.add", details: { role: `ADMIN ${SECRET}` } }),
    ]);
    const { res } = await call();
    const s = JSON.stringify(res.body);
    for (const bad of [SECRET, "a@b.com", "alice@example.com", "xxxxx", "apiKey", "u2"]) expect(s).not.toContain(bad);
    expect(res.body.items[0].summary).toBe("Member role changed · member → admin");
    expect(res.body.items[1]).not.toHaveProperty("actor");
    expect(res.body.items[2]).toMatchObject({ action: "unknown", summary: "Event" });
    expect(res.body.items[3].summary).toBe("Member added");
    expect(Object.keys(logFindMany.mock.calls[0][0].select).sort()).toEqual(["action", "actor", "createdAt", "details", "id"]);
    expect(summarizeCompany("company.nope", {})).toBe("Event (company.nope)");
    expect(Object.keys(COMPANY_ACTION_LABELS).every((k) => k.startsWith("company."))).toBe(true);
  });
});

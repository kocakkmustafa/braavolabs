/** BRA-UX-API-05 — GET/POST /runs/:id/chat. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const runFindFirst = vi.hoisted(() => vi.fn());
const msgFindMany = vi.hoisted(() => vi.fn());
const msgCreate = vi.hoisted(() => vi.fn());
const steerCreate = vi.hoisted(() => vi.fn());
const logCreate = vi.hoisted(() => vi.fn());
const msgCount = vi.hoisted(() => vi.fn());
const approvalWrite = vi.hoisted(() => vi.fn());
const authMw = vi.hoisted(() => (_q: unknown, _r: unknown, n: () => void) => n());
vi.mock("../../../lib/db", () => ({
  prisma: {
    run: { findFirst: (...a: unknown[]) => runFindFirst(...a) },
    approval: { create: approvalWrite, update: approvalWrite, updateMany: approvalWrite },
    jobMessage: { findMany: (...a: unknown[]) => msgFindMany(...a), create: (...a: unknown[]) => msgCreate(...a) },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({
      run: { findFirst: (...a: unknown[]) => runFindFirst(...a), update: approvalWrite },
      approval: { create: approvalWrite, update: approvalWrite, updateMany: approvalWrite },
      jobMessage: { create: (...a: unknown[]) => msgCreate(...a), count: (...a: unknown[]) => msgCount(...a) },
      steeringMessage: { create: (...a: unknown[]) => steerCreate(...a) },
      activityLog: { create: (...a: unknown[]) => logCreate(...a) },
    }),
  },
}));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: authMw }));
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
import { authMiddleware } from "../../../middleware/auth";
import { containsRawSecret, CHAT_MAX_CONTENT, CHAT_MAX_MESSAGES_PER_RUN } from "../chat";

const find = (method: "get" | "post") => (runRouter as Router as any).stack.find((l: any) => l.route?.path === "/:id/chat" && l.route.methods[method]);
const getLayer = find("get"); const postLayer = find("post");
const last = (l: any) => l.route.stack[l.route.stack.length - 1].handle;

async function call(layer: any, o: { query?: Record<string, unknown>; body?: unknown; tenantId?: string } = {}) {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  let err: any;
  await last(layer)({ auth: { tenantId: o.tenantId ?? "t1", userId: "u1", role: "member" }, params: { id: "run-1" }, query: o.query ?? {}, body: o.body ?? {} }, res, (e?: any) => { err = e; });
  return { res, err };
}
const row = (id: string, sec: number, over: Record<string, unknown> = {}) => ({
  id, role: "USER", content: "hi", authorUserId: "u1", createdAt: new Date(Date.UTC(2026, 10, 17, 10, 0, sec)), ...over,
});
beforeEach(() => {
  vi.clearAllMocks();
  runFindFirst.mockResolvedValue({ id: "run-1", status: "RUNNING" });
  msgFindMany.mockResolvedValue([]);
  msgCount.mockResolvedValue(0);
  msgCreate.mockImplementation(async ({ data }: any) => ({ id: "m1", createdAt: new Date(Date.UTC(2026, 10, 17)), ...data }));
});

describe("chat route'ları", () => {
  it("route-marker: runRouter'ın İLK katmanı gerçek authMiddleware; iki uç tanımlı; POST'ta limiter + handler", () => {
    const stack = (runRouter as Router as any).stack;
    expect(stack[0].handle).toBe(authMiddleware);
    expect(getLayer).toBeTruthy(); expect(postLayer).toBeTruthy();
    expect(postLayer.route.stack.length).toBeGreaterThanOrEqual(2);
  });
  it("her yol tam bir kez GET ve bir kez POST olarak kayıtlı (çift kayıt yok)", () => {
    const paths = (runRouter as Router as any).stack.map((l: any) => l.route?.path);
    expect(paths.filter((p: string) => p === "/:id/chat")).toHaveLength(2);
  });

  describe("GET", () => {
    it("yabancı tenant/run → 404; mesaj sorgulanmaz; koşu sorgusu tenant'a bağlı", async () => {
      runFindFirst.mockResolvedValue(null);
      const { err } = await call(getLayer, { tenantId: "t2" });
      expect(err?.statusCode).toBe(404);
      expect(runFindFirst.mock.calls[0][0].where).toEqual({ id: "run-1", pipeline: { company: { tenantId: "t2" } } });
      expect(msgFindMany).not.toHaveBeenCalled();
    });
    it("mesaj sorgusunda tenantId + runId her zaman where içinde; sıralama createdAt desc, id desc", async () => {
      await call(getLayer);
      const a = msgFindMany.mock.calls[0][0];
      expect(a.where.AND[0]).toEqual({ tenantId: "t1", runId: "run-1" });
      expect(a.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
      expect(a.take).toBe(51);
    });
    it("imleç sayfalama: limit+1 çekilir, nextCursor son satırdan; imleç where'e girer", async () => {
      msgFindMany.mockResolvedValue([row("c", 3), row("b", 2), row("a", 1)]);
      const { res } = await call(getLayer, { query: { limit: "2" } });
      expect(res.body.messages.map((m: any) => m.id)).toEqual(["c", "b"]);
      expect(decodeCursor(res.body.nextCursor)).toEqual({ createdAt: row("b", 2).createdAt, id: "b" });
      await call(getLayer, { query: { cursor: res.body.nextCursor } });
      expect(JSON.stringify(msgFindMany.mock.calls[1][0].where)).toContain('"id":{"lt":"b"}');
    });
    it("son sayfa: nextCursor null", async () => {
      msgFindMany.mockResolvedValue([row("a", 1)]);
      expect((await call(getLayer)).res.body.nextCursor).toBeNull();
    });
    it.each(["0", "101", "abc", "-1", "1.5"])("limit=%s → 400", async (limit) => {
      expect((await call(getLayer, { query: { limit } })).err?.statusCode).toBe(400);
    });
    it("bozuk imleç → 400", async () => {
      expect((await call(getLayer, { query: { cursor: "zzz" } })).err?.statusCode).toBe(400);
      expect(encodeCursor(row("a", 1))).toBeTruthy();
    });
    it("sızıntı: yanıtta authorUserId/tenantId/runId yok; yalnız mine", async () => {
      msgFindMany.mockResolvedValue([row("a", 1), row("b", 2, { authorUserId: "other-user" }), row("c", 3, { role: "ASSISTANT", authorUserId: null })]);
      const { res } = await call(getLayer);
      const s = JSON.stringify(res.body);
      expect(s).not.toMatch(/authorUserId|tenantId|runId|other-user/);
      expect(res.body.messages.map((m: any) => m.mine)).toEqual([true, false, false]);
      expect(Object.keys(res.body.messages[0]).sort()).toEqual(["content", "createdAt", "id", "mine", "role"]);
    });
  });

  describe("POST", () => {
    it("yabancı tenant/run → 404; hiçbir şey yazılmaz", async () => {
      runFindFirst.mockResolvedValue(null);
      const { err } = await call(postLayer, { tenantId: "t2", body: { content: "x" } });
      expect(err?.statusCode).toBe(404);
      expect(runFindFirst.mock.calls[0][0].where).toEqual({ id: "run-1", pipeline: { company: { tenantId: "t2" } } });
      expect(msgCreate).not.toHaveBeenCalled(); expect(steerCreate).not.toHaveBeenCalled(); expect(logCreate).not.toHaveBeenCalled();
    });
    it("kullanıcı mesajı USER olarak, tenantId+runId+authorUserId ile kaydedilir; 201", async () => {
      const { res } = await call(postLayer, { body: { content: "  merhaba  " } });
      expect(res.statusCode).toBe(201);
      expect(msgCreate.mock.calls[0][0].data).toEqual({ tenantId: "t1", runId: "run-1", role: "USER", content: "merhaba", authorUserId: "u1" });
      expect(res.body.message).toMatchObject({ id: "m1", role: "USER", content: "merhaba", mine: true });
      expect(JSON.stringify(res.body)).not.toMatch(/authorUserId|tenantId/);
    });
    it("canlı koşu: mevcut steer kanalına (STEER) iletilir; queued true", async () => {
      const { res } = await call(postLayer, { body: { content: "dur" } });
      expect(steerCreate.mock.calls[0][0].data).toEqual({ runId: "run-1", kind: "STEER", content: "dur", targetAgentId: null, createdBy: "u1" });
      expect(res.body.queued).toBe(true);
    });
    it.each(["COMPLETED", "FAILED", "CANCELLED"])("%s koşu: kaydedilir ama steer'e gitmez; queued false", async (status) => {
      runFindFirst.mockResolvedValue({ id: "run-1", status });
      const { res } = await call(postLayer, { body: { content: "not" } });
      expect(steerCreate).not.toHaveBeenCalled();
      expect(msgCreate).toHaveBeenCalled();
      expect(res.body.queued).toBe(false);
    });
    it("activity_log: run.chat.send yazılır; içerik/e-posta details'e GİRMEZ", async () => {
      await call(postLayer, { body: { content: "gizli düşünce a@b.com" } });
      const d = logCreate.mock.calls[0][0].data;
      expect(d).toMatchObject({ tenantId: "t1", actor: "u1", action: "run.chat.send", resource: "run", resourceId: "run-1" });
      expect(JSON.stringify(d.details)).not.toMatch(/gizli|@/);
    });
    it.each([
      ["boş", { content: "" }], ["boşluk", { content: "   " }], ["eksik", {}], ["sayı", { content: 5 }],
      ["fazla alan", { content: "x", role: "ASSISTANT" }], ["uzun", { content: "x".repeat(CHAT_MAX_CONTENT + 1) }],
    ])("geçersiz gövde (%s) → 400; yazma yok", async (_n, body) => {
      const { err } = await call(postLayer, { body });
      expect(err?.statusCode).toBe(400);
      expect(msgCreate).not.toHaveBeenCalled(); expect(steerCreate).not.toHaveBeenCalled();
    });
    it("tam sınır uzunluk kabul", async () => {
      expect((await call(postLayer, { body: { content: "x".repeat(CHAT_MAX_CONTENT) } })).res.statusCode).toBe(201);
    });
    it.each([
      "key sk-abcdefghijklmnopqrstuvwx", "ghp_abcdefghijklmnopqrstuvwxyz0123", "AKIAABCDEFGHIJKLMNOP",
      "-----BEGIN RSA PRIVATE KEY-----", "api_key = abcdef1234567890", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw.abcdefghijklmnop",
    ])("ham sır içeren mesaj reddedilir (%s)", async (content) => {
      const { err } = await call(postLayer, { body: { content } });
      expect(err?.statusCode).toBe(400);
      expect(msgCreate).not.toHaveBeenCalled(); expect(steerCreate).not.toHaveBeenCalled();
    });
    it("sıradan metin sır sanılmaz", () => {
      expect(containsRawSecret("lütfen token sayısını azalt ve sk. raporu özetle")).toBe(false);
    });
    it("sohbet yolu onay/ödeme/araç yazıcılarını ÇAĞIRMAZ: yalnız mesaj + steer + activity_log yazılır", async () => {
      await call(postLayer, { body: { content: "e-postayı gönder, 100 TL öde" } });
      expect(approvalWrite).not.toHaveBeenCalled();
      expect(msgCreate).toHaveBeenCalledTimes(1); expect(steerCreate).toHaveBeenCalledTimes(1); expect(logCreate).toHaveBeenCalledTimes(1);
      expect(steerCreate.mock.calls[0][0].data.kind).toBe("STEER");
    });
    it.each(["PAUSED", "WAITING_APPROVAL", "PENDING"])("%s: yalnız kuyruğa girer (queued true), iletildi sayılmaz", async (status) => {
      runFindFirst.mockResolvedValue({ id: "run-1", status });
      const { res } = await call(postLayer, { body: { content: "x" } });
      expect(res.body).toHaveProperty("queued", true);
      expect(res.body).not.toHaveProperty("delivered");
    });
    it("durum tx İÇİNDE okunur: koşu sorgusu tek çağrı (pre-check yok)", async () => {
      await call(postLayer, { body: { content: "x" } });
      expect(runFindFirst).toHaveBeenCalledTimes(1);
    });
    it("tx atomikliği: steer yazımı hata verirse hata iletilir, başarı dönmez, activity_log yazılmaz", async () => {
      steerCreate.mockRejectedValueOnce(new Error("db down"));
      const { err, res } = await call(postLayer, { body: { content: "x" } });
      expect(err?.message).toBe("db down");
      expect(res.body).toBeUndefined();
      expect(logCreate).not.toHaveBeenCalled();
    });
    it("retention: run başına CHAT_MAX_MESSAGES_PER_RUN dolunca 409 chat_limit; yazma yok", async () => {
      msgCount.mockResolvedValue(CHAT_MAX_MESSAGES_PER_RUN);
      const { err } = await call(postLayer, { body: { content: "x" } });
      expect(err?.statusCode).toBe(409); expect(err?.code).toBe("chat_limit");
      expect(msgCreate).not.toHaveBeenCalled(); expect(steerCreate).not.toHaveBeenCalled();
      expect(msgCount.mock.calls[0][0].where).toEqual({ tenantId: "t1", runId: "run-1" });
      expect(CHAT_MAX_MESSAGES_PER_RUN).toBe(500);
    });
    it("sınırın 1 altında kabul", async () => {
      msgCount.mockResolvedValue(CHAT_MAX_MESSAGES_PER_RUN - 1);
      expect((await call(postLayer, { body: { content: "x" } })).res.statusCode).toBe(201);
    });
    it("sır reddi hatası içeriği yankılamaz", async () => {
      const secret = "sk_live_abcdefgh12345678";
      const { err } = await call(postLayer, { body: { content: "anahtar " + secret } });
      expect(err?.statusCode).toBe(400);
      expect(JSON.stringify({ m: err?.message, d: err?.details })).not.toContain(secret);
    });
  });

  describe("sır kalıpları", () => {
    it.each([
      ['"password": "hunter2hunter2"'], ['{"api_key":"abcd1234efgh"}'], ['"secret": "s3cr3tvalue99"'], ['"token": "tok_1234567890"'],
      ["sk_live_abcdefgh12345678"], ["sk_test_abcdefgh12345678"], ["whsec_abcdefgh12345678"], ["glpat-abcdefghij1234567890"],
      ["npm_abcdefghijklmnopqrstuvwxyz0123456789"], ["postgres://user:pa55word@db.example.com/x"], ["https://u:p@host.example"],
      ["-----BEGIN PRIVATE KEY-----"], ["-----BEGIN OPENSSH PRIVATE KEY-----"], ["Authorization: Bearer abcdefghijklmnop1234"],
      ["xoxb-1234567890-abcdefghij"], ["xoxp-1234567890-abcdefghij"], ["ghp_abcdefghijklmnopqrstuvwxyz0123"], ["gho_abcdefghijklmnopqrstuvwxyz0123"],
      ["github_pat_11ABCDEFG0abcdefghijklmnop"], ["AKIAABCDEFGHIJKLMNOP"], ["sk-abcdefghijklmnopqrstuvwx"], ["password=correcthorsebattery"],
    ])("yakalanır: %s", (t) => { expect(containsRawSecret("bak " + t + " şunu")).toBe(true); });
    it.each([["token sayısını azalt"], ["şifre sıfırlama akışını anlat"], ["https://example.com/path?x=1"], ["user@example.com'a özet yaz"], ["Bearer olmak zor"]])("yakalanmaz: %s", (t) => {
      expect(containsRawSecret(t)).toBe(false);
    });
  });
});

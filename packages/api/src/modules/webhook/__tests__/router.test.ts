/**
 * POST /hooks/:companySlug/:event — inbound webhook signature/replay/tenant
 * resolution (FINDINGS H1 cross-tenant slug collision, H5 replay dedup).
 *
 * The handler is exercised directly (same harness as explain-router.test.ts
 * / handoff-router.test.ts) — extracted from the Router stack with a mock
 * req/res/next and fully mocked prisma / redis / quota services. The `raw()`
 * body-parser middleware ahead of the handler in the real Express stack is
 * not exercised here; tests set `req.body` to a Buffer directly, mirroring
 * what that middleware produces.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const companyFindMany = vi.hoisted(() => vi.fn());
const pipelineFindMany = vi.hoisted(() => vi.fn());
const runCreate = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: {
    company: { findMany: (...a: unknown[]) => companyFindMany(...a) },
    pipeline: { findMany: (...a: unknown[]) => pipelineFindMany(...a) },
    run: { create: (...a: unknown[]) => runCreate(...a) },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
  },
}));

const redisIncr = vi.hoisted(() => vi.fn());
const redisExpire = vi.hoisted(() => vi.fn());
const redisSet = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/redis", () => ({
  redis: {
    incr: (...a: unknown[]) => redisIncr(...a),
    expire: (...a: unknown[]) => redisExpire(...a),
    set: (...a: unknown[]) => redisSet(...a),
  },
}));

const enqueueRunMock = vi.hoisted(() => vi.fn());
vi.mock("../../pipeline/runner", () => ({ enqueueRun: (...a: unknown[]) => enqueueRunMock(...a) }));

const claimQuotaMock = vi.hoisted(() => vi.fn());
const releaseQuotaMock = vi.hoisted(() => vi.fn());
vi.mock("../../billing/metering", () => ({
  claimQuota: (...a: unknown[]) => claimQuotaMock(...a),
  releaseQuota: (...a: unknown[]) => releaseQuotaMock(...a),
}));

vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const envMock = vi.hoisted(() => ({ APP_URL: "https://app.braavolabs.com" }));
vi.mock("../../../config/env", () => ({ env: envMock }));

import { webhookRouter } from "../router";

function getHandler(router: Router, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()],
  );
  if (!layer) throw new Error(`No route ${method} ${path}`);
  const stack = layer.route.stack;
  // Last middleware in the route's stack is the async handler — the raw()
  // body parser sits before it and isn't exercised here (see file header).
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

async function invoke(handler: (req: any, res: any, next: any) => Promise<void> | void, req: any) {
  const res = mockRes();
  let nextErr: any;
  const next = (err?: any) => { nextErr = err; };
  await handler(
    { params: {}, body: Buffer.from(""), headers: {}, ...req },
    res,
    next,
  );
  return { res, nextErr };
}

const SECRET = "whsec_test_secret";
const COMPANY = { id: "company-1", tenantId: "tenant-1", slug: "acme", status: "ACTIVE", config: { webhookSecret: SECRET } };

function sign(timestamp: string, body: Buffer, secret = SECRET): string {
  return crypto.createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${timestamp}.`), body])).digest("hex");
}

describe("POST /hooks/:companySlug/:event", () => {
  const handler = getHandler(webhookRouter, "post", "/:companySlug/:event");

  beforeEach(() => {
    vi.clearAllMocks();
    redisIncr.mockResolvedValue(1);
    redisExpire.mockResolvedValue(1);
    redisSet.mockResolvedValue("OK"); // NX SETNX succeeds → not a duplicate
    companyFindMany.mockResolvedValue([COMPANY]);
    pipelineFindMany.mockResolvedValue([]);
    activityLogCreate.mockResolvedValue({});
    // clearAllMocks() only resets call history, not implementations set via
    // mockResolvedValue/mockRejectedValue (non-"Once" variants) — reset
    // every mock touched by a per-test override back to a safe default
    // here, matching the pattern in handoff-router.test.ts. Without this,
    // a later test's mockRejectedValue leaks into every subsequent test.
    runCreate.mockResolvedValue({ id: "run-x" });
    claimQuotaMock.mockResolvedValue({ claimed: true, value: 1, limit: 100 });
    releaseQuotaMock.mockResolvedValue(undefined);
    enqueueRunMock.mockResolvedValue(undefined);
  });

  function validReq(overrides: Record<string, unknown> = {}) {
    const body = Buffer.from(JSON.stringify({ hello: "world" }));
    const timestamp = String(Date.now());
    const signature = sign(timestamp, body);
    return {
      params: { companySlug: "acme", event: "order.created" },
      body,
      headers: { "x-webhook-signature": signature, "x-webhook-timestamp": timestamp },
      ...overrides,
    };
  }

  it("missing signature header → 401, no DB lookups", async () => {
    const { res, nextErr } = await invoke(handler, {
      params: { companySlug: "acme", event: "order.created" },
      headers: {},
    });
    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/signature/i);
    expect(companyFindMany).not.toHaveBeenCalled();
  });

  it("missing timestamp header → 401", async () => {
    const body = Buffer.from("{}");
    const { res } = await invoke(handler, {
      params: { companySlug: "acme", event: "order.created" },
      body,
      headers: { "x-webhook-signature": "deadbeef" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/timestamp/i);
  });

  it("stale timestamp (> 5 minutes old) → 401, rejected before any signature work", async () => {
    const body = Buffer.from("{}");
    const staleTs = String(Date.now() - 6 * 60_000);
    const { res } = await invoke(handler, {
      params: { companySlug: "acme", event: "order.created" },
      body,
      headers: { "x-webhook-signature": "deadbeef", "x-webhook-timestamp": staleTs },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/too old|invalid/i);
    expect(companyFindMany).not.toHaveBeenCalled();
  });

  it("non-numeric timestamp → 401", async () => {
    const body = Buffer.from("{}");
    const { res } = await invoke(handler, {
      params: { companySlug: "acme", event: "order.created" },
      body,
      headers: { "x-webhook-signature": "deadbeef", "x-webhook-timestamp": "not-a-number" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("no ACTIVE company for the slug → 404", async () => {
    companyFindMany.mockResolvedValue([]);
    const { res } = await invoke(handler, validReq());
    expect(res.statusCode).toBe(404);
  });

  it("company has no webhookSecret configured → 403 (misconfiguration, distinct from bad signature)", async () => {
    companyFindMany.mockResolvedValue([{ ...COMPANY, config: {} }]);
    const { res } = await invoke(handler, validReq());
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/secret not configured/i);
  });

  it("valid HMAC against the company's secret → passes signature verification and triggers no pipeline (none configured)", async () => {
    const { res, nextErr } = await invoke(handler, validReq());
    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(res.body.received).toBe(true);
    expect(res.body.triggeredRuns).toEqual([]);
  });

  it("wrong signature (tampered body / bad secret) → 401, no run created", async () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }));
    const timestamp = String(Date.now());
    const badSignature = sign(timestamp, body, "wrong-secret");
    const { res } = await invoke(handler, {
      params: { companySlug: "acme", event: "order.created" },
      body,
      headers: { "x-webhook-signature": badSignature, "x-webhook-timestamp": timestamp },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/invalid webhook signature/i);
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("FINDINGS H1: two tenants sharing a slug — signature disambiguates to the RIGHT tenant, not just the first match", async () => {
    const otherSecret = "whsec_other_tenant";
    const otherCompany = { id: "company-2", tenantId: "tenant-2", slug: "acme", status: "ACTIVE", config: { webhookSecret: otherSecret } };
    // The wrong-tenant candidate is resolved FIRST by the query order —
    // if the handler picked candidates[0] blindly this would misroute.
    companyFindMany.mockResolvedValue([otherCompany, COMPANY]);

    const { res } = await invoke(handler, validReq()); // signed with COMPANY's secret

    expect(res.statusCode).toBe(200);
    expect(activityLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tenantId: "tenant-1" }) }),
    );
  });

  it("FINDINGS H5: a second delivery with the same signature within the replay window is deduped, no pipeline re-triggered", async () => {
    redisSet.mockResolvedValueOnce("OK").mockResolvedValueOnce(null); // 2nd SETNX fails = duplicate
    pipelineFindMany.mockResolvedValue([{ id: "pipe-1", companyId: "company-1", trigger: "WEBHOOK", enabled: true }]);
    claimQuotaMock.mockResolvedValue({ claimed: true, value: 1, limit: 100 });
    runCreate.mockResolvedValue({ id: "run-1" });

    const req = validReq();
    const first = await invoke(handler, { ...req, body: Buffer.from(JSON.stringify({ hello: "world" })) });
    expect(first.res.body.triggeredRuns).toEqual(["run-1"]);

    const second = await invoke(handler, { ...req, body: Buffer.from(JSON.stringify({ hello: "world" })) });
    expect(second.res.body.duplicate).toBe(true);
    expect(second.res.body.triggeredRuns).toEqual([]);
    expect(runCreate).toHaveBeenCalledTimes(1);
  });

  it("redis down for the replay dedup check → fails open, delivery still processed", async () => {
    redisSet.mockRejectedValue(new Error("redis unreachable"));
    const { res, nextErr } = await invoke(handler, validReq());
    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(200);
  });

  it("redis down for the per-slug rate limit → fails open, delivery still processed", async () => {
    redisIncr.mockRejectedValue(new Error("redis unreachable"));
    const { res } = await invoke(handler, validReq());
    expect(res.statusCode).toBe(200);
  });

  it("per-slug rate limit exceeded → 429, before any DB lookup", async () => {
    redisIncr.mockResolvedValue(301);
    const { res } = await invoke(handler, validReq());
    expect(res.statusCode).toBe(429);
    expect(companyFindMany).not.toHaveBeenCalled();
  });

  it("invalid JSON body (but valid signature over the raw bytes) → 400", async () => {
    const body = Buffer.from("not json{{{");
    const timestamp = String(Date.now());
    const signature = sign(timestamp, body);
    const { res } = await invoke(handler, {
      params: { companySlug: "acme", event: "order.created" },
      body,
      headers: { "x-webhook-signature": signature, "x-webhook-timestamp": timestamp },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/not valid json/i);
  });

  it("quota exhausted for the tenant → pipeline skipped, no run created, delivery still 200s", async () => {
    pipelineFindMany.mockResolvedValue([{ id: "pipe-1", companyId: "company-1", trigger: "WEBHOOK", enabled: true }]);
    claimQuotaMock.mockResolvedValue({ claimed: false, value: 100, limit: 100 });

    const { res } = await invoke(handler, validReq());

    expect(res.statusCode).toBe(200);
    expect(res.body.triggeredRuns).toEqual([]);
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("enqueueRun throws after quota claimed → quota is refunded and the pipeline is skipped (not the whole delivery)", async () => {
    pipelineFindMany.mockResolvedValue([{ id: "pipe-1", companyId: "company-1", trigger: "WEBHOOK", enabled: true }]);
    claimQuotaMock.mockResolvedValue({ claimed: true, value: 1, limit: 100 });
    runCreate.mockResolvedValue({ id: "run-1" });
    enqueueRunMock.mockRejectedValue(new Error("queue unavailable"));

    const { res } = await invoke(handler, validReq());

    expect(res.statusCode).toBe(200);
    expect(res.body.triggeredRuns).toEqual([]);
    expect(releaseQuotaMock).toHaveBeenCalledWith("tenant-1", "runs");
  });

  it("multiple matching pipelines each claim quota independently and all appear in triggeredRuns", async () => {
    pipelineFindMany.mockResolvedValue([
      { id: "pipe-1", companyId: "company-1", trigger: "WEBHOOK", enabled: true },
      { id: "pipe-2", companyId: "company-1", trigger: "WEBHOOK", enabled: true },
    ]);
    claimQuotaMock.mockResolvedValue({ claimed: true, value: 1, limit: 100 });
    runCreate.mockResolvedValueOnce({ id: "run-1" }).mockResolvedValueOnce({ id: "run-2" });

    const { res } = await invoke(handler, validReq());

    expect(res.body.triggeredRuns).toEqual(["run-1", "run-2"]);
    expect(claimQuotaMock).toHaveBeenCalledTimes(2);
  });

  it("empty body (no Content-Type) is normalized to an empty buffer and still verified", async () => {
    const timestamp = String(Date.now());
    const signature = sign(timestamp, Buffer.from(""));
    const { res } = await invoke(handler, {
      params: { companySlug: "acme", event: "order.created" },
      body: undefined, // not a Buffer — raw() left nothing parsed
      headers: { "x-webhook-signature": signature, "x-webhook-timestamp": timestamp },
    });
    expect(res.statusCode).toBe(200);
  });
});

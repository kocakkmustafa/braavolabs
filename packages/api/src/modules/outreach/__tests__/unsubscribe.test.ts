import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

const upsert = vi.hoisted(() => vi.fn());
const updateMany = vi.hoisted(() => vi.fn());
const activityCreate = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    emailSuppression: { upsert: (...a: unknown[]) => upsert(...a) },
    outreachEnrollment: { updateMany: (...a: unknown[]) => updateMany(...a) },
    activityLog: { create: (...a: unknown[]) => activityCreate(...a) },
  },
}));
vi.mock("../../../lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("../../../middleware/rateLimit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../config/env", () => ({
  env: { JWT_SECRET: "test-jwt-secret-at-least-32-characters-long-xx", API_PUBLIC_URL: "https://api.example.test" },
}));

import { unsubscribeRouter } from "../unsubscribe.router";
import { createUnsubscribeToken } from "../../../lib/unsubscribe-token";

function run(method: "get" | "post", token: unknown, body?: Record<string, unknown>) {
  const layer = (unsubscribeRouter as Router & { stack: any[] }).stack.find(
    (l) => l.route?.path === "/" && l.route.methods[method],
  );
  const handle = layer.route.stack.at(-1).handle;
  const json = vi.fn();
  const send = vi.fn();
  const type = vi.fn(() => ({ send }));
  const res = { status: vi.fn(() => ({ json, type })), setHeader: vi.fn() };
  let error: unknown;
  return handle({ query: { token }, body }, res, (e?: unknown) => { error = e; })
    .then(() => ({ res, json, send, type, error }));
}

beforeEach(() => {
  vi.clearAllMocks();
  upsert.mockResolvedValue({});
  updateMany.mockResolvedValue({ count: 2 });
  activityCreate.mockResolvedValue({});
});

describe("public unsubscribe", () => {
  it("POST with a valid query token (RFC 8058 one-click): suppresses, unsubscribes enrollments, logs, 200", async () => {
    const { res, json, error } = await run("post", createUnsubscribeToken("tenant-1", "Lead@Example.test"));
    expect(error).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ success: true });
    expect(upsert).toHaveBeenCalledWith({
      where: { tenantId_email: { tenantId: "tenant-1", email: "lead@example.test" } },
      create: { tenantId: "tenant-1", email: "lead@example.test", reason: "UNSUBSCRIBE" },
      update: {},
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        status: { in: ["ACTIVE", "PAUSED"] },
        contact: { email: { equals: "lead@example.test", mode: "insensitive" }, company: { tenantId: "tenant-1" } },
      },
      data: { status: "UNSUBSCRIBED", unsubscribedAt: expect.any(Date) },
    });
    expect(activityCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: "tenant-1", action: "outreach.unsubscribe_public" }),
    });
  });

  it("POST from the confirmation form (token in the body) works the same", async () => {
    const { res, json } = await run("post", undefined, { token: createUnsubscribeToken("tenant-1", "lead@example.test") });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ success: true });
    expect(upsert).toHaveBeenCalledOnce();
  });

  it("GET with a valid token changes NOTHING and returns the confirmation page", async () => {
    const token = createUnsubscribeToken("tenant-1", "lead@example.test");
    const { res, type, send } = await run("get", token);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(type).toHaveBeenCalledWith("html");
    const html = send.mock.calls[0][0] as string;
    expect(html).toContain("Confirm unsubscribe");
    expect(html).toContain('method="post"');
    expect(html).toContain(`name="token" value="${token}"`);
    expect(upsert).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it("GET page escapes the token (XSS): a tampered token is 404, and the escaper neutralises markup", async () => {
    const evil = '"><script>alert(1)</script>';
    const bad = await run("get", evil);
    expect(bad.res.status).toHaveBeenCalledWith(404);
    expect(bad.send).not.toHaveBeenCalled();
    // A validly signed token whose payload part contains characters the escaper handles:
    // build one then check no raw quote / angle bracket can appear in the rendered value.
    const token = createUnsubscribeToken("tenant-1", 'x"<>&\'@example.test');
    const { send } = await run("get", token);
    const html = send.mock.calls[0][0] as string;
    const value = html.slice(html.indexOf('name="token" value="') + 20, html.indexOf('"><button'));
    expect(value).not.toMatch(/[<>"']/);
  });

  it.each(["get", "post"] as const)("%s with an invalid token: 404 and no writes", async (method) => {
    for (const token of [undefined, "", "garbage", "a.b"]) {
      const { res } = await run(method, token);
      expect(res.status).toHaveBeenCalledWith(404);
    }
    expect(upsert).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(activityCreate).not.toHaveBeenCalled();
  });

  it("a signed token for a deleted tenant (FK error) is a 404, not a 500", async () => {
    upsert.mockRejectedValue(Object.assign(new Error("fk"), { code: "P2003" }));
    const { res, error } = await run("post", createUnsubscribeToken("gone", "a@b.test"));
    expect(error).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

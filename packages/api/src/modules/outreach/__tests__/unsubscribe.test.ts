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

function run(method: "get" | "post", token: unknown) {
  const layer = (unsubscribeRouter as Router & { stack: any[] }).stack.find(
    (l) => l.route?.path === "/" && l.route.methods[method],
  );
  const handle = layer.route.stack.at(-1).handle;
  const json = vi.fn();
  const res = { status: vi.fn(() => ({ json })) };
  let error: unknown;
  return handle({ query: { token } }, res, (e?: unknown) => { error = e; }).then(() => ({ res, json, error }));
}

beforeEach(() => {
  vi.clearAllMocks();
  upsert.mockResolvedValue({});
  updateMany.mockResolvedValue({ count: 2 });
  activityCreate.mockResolvedValue({});
});

describe("public unsubscribe", () => {
  it.each(["get", "post"] as const)("%s with a valid token: suppresses, unsubscribes enrollments, logs, 200", async (method) => {
    const { res, json, error } = await run(method, createUnsubscribeToken("tenant-1", "Lead@Example.test"));
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

  it.each([undefined, "", "garbage", "a.b"])("invalid token %s: 404 and no writes", async (token) => {
    const { res } = await run("get", token);
    expect(res.status).toHaveBeenCalledWith(404);
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

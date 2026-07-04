/**
 * E5/T6 — marketplace moderation routes: POST /connectors/:slug/unapprove
 * (admin-only) and PATCH /connectors/:slug (publisher-only metadata update).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const connectorFindUnique = vi.hoisted(() => vi.fn());
const connectorUpdate = vi.hoisted(() => vi.fn());
const userFindUnique = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    connector: {
      findUnique: (...a: unknown[]) => connectorFindUnique(...a),
      update: (...a: unknown[]) => connectorUpdate(...a),
    },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
  },
}));
vi.mock("../../../lib/mcp", () => ({ listTools: vi.fn() }));
vi.mock("../../billing/metering", () => ({ claimQuota: vi.fn() }));
vi.mock("../../../lib/ssrf", () => ({
  assertSafeExternalUrl: vi.fn(),
  SsrfError: class SsrfError extends Error {},
}));
vi.mock("../../../lib/encryption", () => ({ encrypt: vi.fn(), decrypt: vi.fn() }));
vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { marketplaceRouter } from "../marketplace.router";

function getHandler(router: Router, method: string, path: string) {
  const stacks: any[] = [(router as any).stack];
  while (stacks.length) {
    const stack = stacks.shift();
    for (const layer of stack) {
      if (layer.route && layer.route.path === path && layer.route.methods[method.toLowerCase()]) {
        const s = layer.route.stack;
        return s[s.length - 1].handle as (req: any, res: any, next: any) => Promise<void> | void;
      }
      if (layer.handle && (layer.handle as any).stack) stacks.push((layer.handle as any).stack);
    }
  }
  throw new Error(`No route ${method} ${path}`);
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

async function invoke(handler: any, req: any) {
  const res = mockRes();
  let nextErr: any = undefined;
  const next = (err?: any) => { nextErr = err; };
  await handler(
    { auth: { tenantId: "pub-1", userId: "user-1", role: "member" }, params: {}, body: {}, query: {}, ...req },
    res,
    next,
  );
  return { res, nextErr };
}

const unapprove = getHandler(marketplaceRouter, "post", "/connectors/:slug/unapprove");
const patch = getHandler(marketplaceRouter, "patch", "/connectors/:slug");

beforeEach(() => {
  vi.clearAllMocks();
  activityLogCreate.mockResolvedValue({});
  connectorUpdate.mockResolvedValue({ id: "c1", slug: "acme-crm" });
});

describe("POST /connectors/:slug/unapprove — admin only", () => {
  it("non-admin → 403, no update", async () => {
    process.env.MARKETPLACE_ADMIN_EMAILS = "admin@example.com";
    userFindUnique.mockResolvedValue({ email: "notadmin@example.com" });
    const { nextErr } = await invoke(unapprove, { params: { slug: "acme-crm" } });
    expect(nextErr?.statusCode).toBe(403);
    expect(connectorUpdate).not.toHaveBeenCalled();
    delete process.env.MARKETPLACE_ADMIN_EMAILS;
  });

  it("admin → sets isApproved=false", async () => {
    process.env.MARKETPLACE_ADMIN_EMAILS = "admin@example.com";
    userFindUnique.mockResolvedValue({ email: "admin@example.com" });
    connectorFindUnique.mockResolvedValue({ id: "c1", slug: "acme-crm" });
    const { res, nextErr } = await invoke(unapprove, { params: { slug: "acme-crm" } });
    expect(nextErr).toBeUndefined();
    expect(connectorUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: "acme-crm" }, data: { isApproved: false } }),
    );
    expect(res.body.success).toBe(true);
    delete process.env.MARKETPLACE_ADMIN_EMAILS;
  });

  it("admin, connector not found → 404", async () => {
    process.env.MARKETPLACE_ADMIN_EMAILS = "admin@example.com";
    userFindUnique.mockResolvedValue({ email: "admin@example.com" });
    connectorFindUnique.mockResolvedValue(null);
    const { nextErr } = await invoke(unapprove, { params: { slug: "missing" } });
    expect(nextErr?.statusCode).toBe(404);
    delete process.env.MARKETPLACE_ADMIN_EMAILS;
  });
});

describe("PATCH /connectors/:slug — publisher only", () => {
  it("non-publisher → 403, no update", async () => {
    connectorFindUnique.mockResolvedValue({ id: "c1", slug: "acme-crm", publisherTenantId: "other-tenant" });
    const { nextErr } = await invoke(patch, { params: { slug: "acme-crm" }, body: { name: "New Name" } });
    expect(nextErr?.statusCode).toBe(403);
    expect(connectorUpdate).not.toHaveBeenCalled();
  });

  it("publisher updates cosmetic metadata", async () => {
    connectorFindUnique.mockResolvedValue({ id: "c1", slug: "acme-crm", publisherTenantId: "pub-1" });
    const { res, nextErr } = await invoke(patch, {
      params: { slug: "acme-crm" },
      body: { name: "Acme CRM Pro", description: "Updated." },
    });
    expect(nextErr).toBeUndefined();
    const arg = connectorUpdate.mock.calls[0]![0] as any;
    expect(arg.data).toEqual({ name: "Acme CRM Pro", description: "Updated." });
    // Never touches integrity-relevant fields.
    expect(arg.data.mcpServerUrl).toBeUndefined();
    expect(arg.data.isApproved).toBeUndefined();
    expect(arg.data.manifestSignature).toBeUndefined();
    expect(arg.data.visibility).toBeUndefined();
    expect(res.body.slug).toBe("acme-crm");
  });

  it("connector not found → 404", async () => {
    connectorFindUnique.mockResolvedValue(null);
    const { nextErr } = await invoke(patch, { params: { slug: "missing" }, body: { name: "x" } });
    expect(nextErr?.statusCode).toBe(404);
  });

  it("empty patch (no updatable fields) → 400", async () => {
    connectorFindUnique.mockResolvedValue({ id: "c1", slug: "acme-crm", publisherTenantId: "pub-1" });
    const { nextErr } = await invoke(patch, { params: { slug: "acme-crm" }, body: {} });
    expect(nextErr?.statusCode).toBe(400);
    expect(connectorUpdate).not.toHaveBeenCalled();
  });
});

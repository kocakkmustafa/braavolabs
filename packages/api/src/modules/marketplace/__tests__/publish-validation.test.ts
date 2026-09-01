/**
 * E5/T5 + T6 — POST /marketplace/publish: manifest fail-closed validation,
 * server-side HMAC signing, and the plan/quota/admin publish gate.
 *
 * Router-unit style (mock prisma + extract the handler off the router stack),
 * matching pipeline/__tests__/run-empty-guard.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length >= 32
    ? process.env.ENCRYPTION_KEY
    : "test-encryption-key-32-chars-minimum-1234567890";

vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const connectorFindUnique = vi.hoisted(() => vi.fn());
const connectorUpsert = vi.hoisted(() => vi.fn());
const connectorCount = vi.hoisted(() => vi.fn());
const userFindUnique = vi.hoisted(() => vi.fn());
const tenantFindUnique = vi.hoisted(() => vi.fn());
const activityLogCreate = vi.hoisted(() => vi.fn());
const claimQuotaMock = vi.hoisted(() => vi.fn());
const listToolsMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    connector: {
      findUnique: (...a: unknown[]) => connectorFindUnique(...a),
      upsert: (...a: unknown[]) => connectorUpsert(...a),
      count: (...a: unknown[]) => connectorCount(...a),
    },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    tenant: { findUnique: (...a: unknown[]) => tenantFindUnique(...a) },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
  },
}));
vi.mock("../../../lib/mcp", () => ({ listTools: (...a: unknown[]) => listToolsMock(...a) }));
vi.mock("../../billing/metering", () => ({ claimQuota: (...a: unknown[]) => claimQuotaMock(...a) }));
vi.mock("../../../lib/ssrf", () => ({
  assertSafeExternalUrl: vi.fn().mockResolvedValue(undefined),
  SsrfError: class SsrfError extends Error {},
}));
vi.mock("../../../lib/encryption", () => ({ encrypt: vi.fn(), decrypt: vi.fn() }));
vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { marketplaceRouter } from "../marketplace.router";

function getHandler(router: Router, method: string, path: string) {
  // The tenantRouter is mounted via router.use(); walk nested stacks.
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

const publish = getHandler(marketplaceRouter, "post", "/publish");

const validBody = {
  slug: "acme-crm",
  name: "Acme CRM",
  version: "1.0.0",
  vendor: "Acme Inc.",
  description: "Sync contacts with Acme CRM.",
  mcpServerUrl: "https://mcp.acme.example/rpc",
  authMethod: "API_KEY",
  visibility: "PRIVATE",
  tools: [{ name: "list_contacts", description: "List contacts" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  connectorFindUnique.mockResolvedValue(null); // new publish
  connectorCount.mockResolvedValue(0);
  connectorUpsert.mockImplementation(({ create }: any) => ({
    id: "c1",
    slug: create.slug,
    version: create.version,
    isApproved: create.isApproved,
    visibility: create.visibility,
    manifestSignature: create.manifestSignature,
  }));
  activityLogCreate.mockResolvedValue({});
  userFindUnique.mockResolvedValue({ email: "pub@example.com" }); // non-admin
  tenantFindUnique.mockResolvedValue({ plan: "PRO" }); // publish-capable plan
  claimQuotaMock.mockResolvedValue({ claimed: true, value: 1, limit: -1 });
  listToolsMock.mockResolvedValue([{ name: "list_contacts", description: "List contacts", inputSchema: {} }]);
});

describe("POST /publish — manifest validation (fail-closed)", () => {
  it("rejects an invalid slug (ZodError → 400 via error middleware) and never upserts", async () => {
    const { nextErr } = await invoke(publish, { body: { ...validBody, slug: "Acme_CRM" } });
    expect(nextErr).toBeTruthy();
    expect(nextErr.name).toBe("ZodError");
    expect(connectorUpsert).not.toHaveBeenCalled();
  });

  it("rejects a non-semver version (ZodError → 400 via error middleware) and never upserts", async () => {
    const { nextErr } = await invoke(publish, { body: { ...validBody, version: "1.0" } });
    // publishSchema.parse throws a ZodError first; the global error handler
    // maps ZodError → 400. In this unit test we assert the route rejected
    // BEFORE any persistence.
    expect(nextErr).toBeTruthy();
    expect(nextErr.name).toBe("ZodError");
    expect(connectorUpsert).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range tool name via the SDK manifest schema (400)", async () => {
    // Passes publishSchema (name<=80) but fails connectorManifestSchema's
    // identifier regex → AppError(400) from the manifest safeParse gate.
    const { nextErr } = await invoke(publish, {
      body: { ...validBody, tools: [{ name: "bad name!", description: "x" }] },
    });
    expect(nextErr?.statusCode).toBe(400);
    expect(String(nextErr.message)).toContain("Invalid connector manifest");
    expect(connectorUpsert).not.toHaveBeenCalled();
  });

  it("accepts a valid manifest and signs it server-side", async () => {
    const { res, nextErr } = await invoke(publish, { body: validBody });
    expect(nextErr).toBeUndefined();
    expect(connectorUpsert).toHaveBeenCalledOnce();
    const arg = connectorUpsert.mock.calls[0]![0] as any;
    // The server sets a real HMAC signature — the publisher can't supply one.
    expect(arg.create.manifestSignature).toMatch(/^hmac-sha256:/);
    expect(res.body.slug).toBe("acme-crm");
  });

  it("ignores any publisher-supplied manifestSignature (server signs)", async () => {
    await invoke(publish, { body: { ...validBody, manifestSignature: "hmac-sha256:forged" } });
    const arg = connectorUpsert.mock.calls[0]![0] as any;
    expect(arg.create.manifestSignature).not.toContain("forged");
  });
});

describe("POST /publish — plan / quota / admin gate (T6)", () => {
  it("FREE plan fails closed before quota claim or connector persistence", async () => {
    tenantFindUnique.mockResolvedValue({ plan: "FREE" });
    connectorCount.mockResolvedValue(0);
    const { nextErr } = await invoke(publish, { body: validBody });
    expect(nextErr?.statusCode).toBe(403);
    expect(claimQuotaMock).not.toHaveBeenCalled();
    expect(connectorUpsert).not.toHaveBeenCalled();
  });

  it("FREE plan at its cap (1 already published) is blocked (403)", async () => {
    tenantFindUnique.mockResolvedValue({ plan: "FREE" });
    connectorCount.mockResolvedValue(1); // FREE maxConnectedAutomations = 1
    const { nextErr } = await invoke(publish, { body: validBody });
    expect(nextErr?.statusCode).toBe(403);
    expect(connectorUpsert).not.toHaveBeenCalled();
  });

  it("blocks a new publish when the plan connector limit is reached (403)", async () => {
    tenantFindUnique.mockResolvedValue({ plan: "CREATOR" }); // maxConnectedAutomations = 3
    connectorCount.mockResolvedValue(3);
    const { nextErr } = await invoke(publish, { body: validBody });
    expect(nextErr?.statusCode).toBe(403);
    expect(connectorUpsert).not.toHaveBeenCalled();
  });

  it("claims publish quota on a new publish (429 when refused)", async () => {
    claimQuotaMock.mockResolvedValue({ claimed: false, value: 5, limit: 5 });
    const { nextErr } = await invoke(publish, { body: validBody });
    expect(nextErr?.statusCode).toBe(429);
    expect(connectorUpsert).not.toHaveBeenCalled();
  });

  it("an admin bypasses the plan gate entirely (even on FREE)", async () => {
    process.env.MARKETPLACE_ADMIN_EMAILS = "admin@example.com";
    userFindUnique.mockResolvedValue({ email: "admin@example.com" });
    tenantFindUnique.mockResolvedValue({ plan: "FREE" });
    const { nextErr } = await invoke(publish, { body: validBody });
    expect(nextErr).toBeUndefined();
    expect(claimQuotaMock).not.toHaveBeenCalled();
    expect(connectorUpsert).toHaveBeenCalledOnce();
    delete process.env.MARKETPLACE_ADMIN_EMAILS;
  });

  it("updating an EXISTING owned connector is not gated (no quota claim)", async () => {
    connectorFindUnique.mockResolvedValue({
      id: "c1",
      slug: "acme-crm",
      publisherTenantId: "pub-1",
      isApproved: true,
      version: "1.0.0",
    });
    tenantFindUnique.mockResolvedValue({ plan: "FREE" });
    const { nextErr } = await invoke(publish, { body: validBody });
    expect(nextErr).toBeUndefined();
    expect(claimQuotaMock).not.toHaveBeenCalled();
    expect(connectorUpsert).toHaveBeenCalledOnce();
  });
});

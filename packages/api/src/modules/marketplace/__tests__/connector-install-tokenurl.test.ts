/** BRA-P1-02a-2 — install rejects a tokenUrl outside the connector's domain (400, no credential in message). */
import { describe, it, expect, vi } from "vitest";
import type { Router } from "express";

process.env.ENCRYPTION_KEY = "test-encryption-key-32-chars-minimum-1234567890";

vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const connectorFindUnique = vi.hoisted(() => vi.fn());
const listToolsMock = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: { connector: { findUnique: (...a: unknown[]) => connectorFindUnique(...a) } },
  tenantTx: vi.fn(),
}));
vi.mock("../../../lib/mcp", () => ({ listTools: (...a: unknown[]) => listToolsMock(...a) }));
vi.mock("../../billing/metering", () => ({ claimQuota: vi.fn() }));
vi.mock("../../../lib/encryption", () => ({ encrypt: () => "enc", decrypt: vi.fn() }));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: (_r: unknown, _s: unknown, n: () => void) => n() }));

import { marketplaceRouter } from "../marketplace.router";
import { AppError } from "../../../middleware/error";

function getHandler(router: Router, method: string, path: string) {
  const stacks: any[] = [(router as any).stack];
  while (stacks.length) {
    for (const layer of stacks.shift()) {
      if (layer.route && layer.route.path === path && layer.route.methods[method]) {
        const s = layer.route.stack;
        return s[s.length - 1].handle as (req: any, res: any, next: any) => Promise<void>;
      }
      if (layer.handle?.stack) stacks.push(layer.handle.stack);
    }
  }
  throw new Error("no route");
}
const install = getHandler(marketplaceRouter, "post", "/connectors/:slug/install");

describe("POST /connectors/:slug/install — tokenUrl domain", () => {
  it("400 for a foreign tokenUrl, before any probe; message carries no credential", async () => {
    connectorFindUnique.mockResolvedValue({
      id: "c1", slug: "acme", visibility: "UNLISTED", isApproved: true, publisherTenantId: "p",
      mcpServerUrl: "https://mcp.acme.example/rpc", authMethod: "OAUTH2", toolsManifest: [],
    });
    let nextErr: any;
    await install(
      { auth: { tenantId: "t1", userId: "u1", role: "member" }, params: { slug: "acme" },
        body: { credentials: { refreshToken: "RT-SECRET", clientSecret: "CS-SECRET", tokenUrl: "https://evil.net/token" } }, query: {} },
      { status() { return this; }, json() { return this; } },
      (e?: any) => { nextErr = e; },
    );
    expect(nextErr).toBeInstanceOf(AppError);
    expect(nextErr.statusCode).toBe(400);
    expect(nextErr.message).not.toMatch(/SECRET|evil/);
    expect(listToolsMock).not.toHaveBeenCalled();
  });
});

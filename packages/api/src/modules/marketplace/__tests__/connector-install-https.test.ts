/**
 * SEC-BRA-02b — install probe must not swallow the cleartext-credential refusal.
 */
import { describe, it, expect, vi } from "vitest";
import type { Router } from "express";

process.env.ENCRYPTION_KEY = "test-encryption-key-32-chars-minimum-1234567890";

const loggerWarn = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: loggerWarn, error: vi.fn() },
}));
const connectorFindUnique = vi.hoisted(() => vi.fn());
const listToolsMock = vi.hoisted(() => vi.fn());
const tenantTxMock = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: { connector: { findUnique: (...a: unknown[]) => connectorFindUnique(...a) } },
  tenantTx: (...a: unknown[]) => tenantTxMock(...a),
}));
vi.mock("../../../lib/mcp", () => ({ listTools: (...a: unknown[]) => listToolsMock(...a) }));
vi.mock("../../billing/metering", () => ({ claimQuota: vi.fn() }));
vi.mock("../../../lib/encryption", () => ({ encrypt: () => "enc", decrypt: vi.fn() }));
vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

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

describe("POST /connectors/:slug/install — HTTPS refusal", () => {
  it("rejects with 400 and a clear message instead of caching the publish-time manifest", async () => {
    connectorFindUnique.mockResolvedValue({
      id: "c1", slug: "acme", visibility: "UNLISTED", isApproved: true, publisherTenantId: "p",
      mcpServerUrl: "http://mcp.acme.example/rpc", authMethod: "API_KEY", toolsManifest: [],
    });
    listToolsMock.mockRejectedValue(new AppError(400, "Connector URL rejected: HTTPS is required. x"));
    let nextErr: any;
    await install(
      { auth: { tenantId: "t1", userId: "u1", role: "member" }, params: { slug: "acme" }, body: { credentials: { apiKey: "k" } }, query: {} },
      { status() { return this; }, json() { return this; } },
      (e?: any) => { nextErr = e; },
    );
    expect(nextErr).toBeInstanceOf(AppError);
    expect(nextErr.statusCode).toBe(400);
    expect(nextErr.message).toMatch(/HTTPS olmalı/);
  });

  it("SEC-BRA-02c: a 502 / timeout probe failure is swallowed (warned), not turned into an HTTPS refusal", async () => {
    for (const probeErr of [new AppError(502, "MCP server returned 502"), Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })]) {
      loggerWarn.mockClear();
      connectorFindUnique.mockResolvedValue({
        id: "c1", slug: "acme", visibility: "UNLISTED", isApproved: true, publisherTenantId: "p",
        mcpServerUrl: "https://mcp.acme.example/rpc", authMethod: "API_KEY", toolsManifest: [],
      });
      listToolsMock.mockRejectedValue(probeErr);
      let nextErr: any;
      await install(
        { auth: { tenantId: "t1", userId: "u1", role: "member" }, params: { slug: "acme" }, body: { credentials: { apiKey: "k" } }, query: {} },
        { status() { return this; }, json() { return this; } },
        (e?: any) => { nextErr = e; },
      );
      // The probe failure was logged and the install carried on past the probe
      // (whatever fails later with the stubbed DB is not the probe error).
      expect(loggerWarn).toHaveBeenCalledWith(expect.objectContaining({ err: probeErr }), expect.stringMatching(/probe failed during install/));
      expect(nextErr).not.toBe(probeErr);
      expect(String(nextErr?.message ?? "")).not.toMatch(/HTTPS/);
    }
  });

  it("SEC-BRA-02c: a malformed connector header is rejected with 400 at install (fail-fast, no upsert)", async () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["API_KEY", { headerName: "X Key", apiKey: "k" }],
      ["CUSTOM", { headers: JSON.stringify({ "X-Key": "a\nb" }) }],
    ];
    for (const [authMethod, credentials] of cases) {
      loggerWarn.mockClear();
      connectorFindUnique.mockResolvedValue({
        id: "c1", slug: "acme", visibility: "UNLISTED", isApproved: true, publisherTenantId: "p",
        mcpServerUrl: "https://mcp.acme.example/rpc", authMethod, toolsManifest: [],
      });
      listToolsMock.mockRejectedValue(new AppError(400, "Bağlayıcı başlığı geçersiz"));
      let nextErr: any;
      await install(
        { auth: { tenantId: "t1", userId: "u1", role: "member" }, params: { slug: "acme" }, body: { credentials }, query: {} },
        { status() { return this; }, json() { return this; } },
        (e?: any) => { nextErr = e; },
      );
      expect(nextErr).toBeInstanceOf(AppError);
      expect(nextErr.statusCode).toBe(400);
      expect(nextErr.message).toBe("Bağlayıcı başlığı geçersiz");
      expect(loggerWarn).not.toHaveBeenCalled();
      expect(tenantTxMock).not.toHaveBeenCalled();
    }
  });
});

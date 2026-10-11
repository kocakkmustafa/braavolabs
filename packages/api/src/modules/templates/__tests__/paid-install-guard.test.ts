import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

const db = vi.hoisted(() => ({
  findUnique: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.auth = { tenantId: "tenant-test", userId: "user-test" };
    next();
  },
}));
vi.mock("../../../lib/db", () => ({
  prisma: { companyTemplate: { findUnique: db.findUnique } },
  tenantTx: db.transaction,
}));
vi.mock("../../../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const { templatesRouter } = await import("../templates.router");
  const app = express();
  app.use(express.json());
  app.use("/api/v1/marketplace/templates", templatesRouter);
  app.use((err: any, _req: any, res: any, _next: any) =>
    res.status(err?.statusCode ?? err?.status ?? 500).json({ error: err?.message ?? "error" }));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("paid template install gate", () => {
  it("refuses a caller-supplied payment intent before any database write", async () => {
    const res = await fetch(`${baseUrl}/api/v1/marketplace/templates/paid-example/install-paid`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentIntentId: "pi_unverified" }),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("verified checkout") });
    expect(db.findUnique).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

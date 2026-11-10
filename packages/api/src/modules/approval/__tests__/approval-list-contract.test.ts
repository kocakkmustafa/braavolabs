/**
 * BRA-P0-04h — GET /approvals yanıt-anahtar sözleşmesi: açık select, izinli anahtar
 * kümesi dışında alan yok (input/output/error/steps/config sırları/nonce …), iç içe dahil.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

const approvalFindMany = vi.hoisted(() => vi.fn());
const runFindMany = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({
  prisma: {
    approval: { findMany: (...a: unknown[]) => approvalFindMany(...a) },
    run: { findMany: (...a: unknown[]) => runFindMany(...a) },
    draft: { findFirst: vi.fn().mockResolvedValue(null) },
  },
  tenantTx: vi.fn(),
}));
vi.mock("../../../middleware/auth", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../middleware/require-permission", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../pipeline/runner", () => ({ enqueueRun: vi.fn() }));
vi.mock("../../external/control", () => ({ runControlAction: vi.fn() }));
vi.mock("../../../config/env", () => ({ env: { NODE_ENV: "test", OFFLINE_MODE: false } }));

import { approvalRouter } from "../router";
import { APPROVAL_LIST_SELECT } from "../list-select";

function getHandler(router: Router, path: string) {
  const layer = (router as any).stack.find((l: any) => l.route && l.route.path === path && l.route.methods.get);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void>;
}
const handler = getHandler(approvalRouter, "/");

async function invoke(query: Record<string, unknown> = {}, tenantId = "tenant-1") {
  const headers: Record<string, string> = {};
  const res: any = {
    statusCode: 200,
    body: undefined,
    setHeader(k: string, v: string) { headers[k] = v; },
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
  };
  let nextErr: any;
  await handler({ auth: { tenantId, userId: "u", role: "admin" }, query }, res, (e?: any) => { nextErr = e; });
  return { res, headers, nextErr };
}


const APPROVAL_KEYS = [
  "amountUsd", "artifact", "createdAt", "decidedAt", "decidedBy", "description", "details", "expiresAt",
  "id", "metadata", "run", "runId", "status", "type",
];
const RUN_KEYS = ["id", "pipeline"];
const PIPELINE_KEYS = ["company", "id", "name"];
const COMPANY_KEYS = ["config", "id", "name", "slug"];
const FORBIDDEN = ["input", "output", "error", "steps", "nonce", "actionHash", "tenantId", "consumedAt", "webhookSecret"];

/** DB'nin select'e göre döndüreceği satır; metadata'ya geniş/gizli anahtarlar konur. */
function row(i: number, runId = `run-${i}`) {
  return {
    id: `ap-${i}`, runId, type: "SPEND", status: "PENDING", description: "d", amountUsd: null,
    metadata: { toolName: "send_email", input: { to: "SECRET-INPUT" }, note: "SECRET-NOTE", handoffId: "h1" },
    decidedBy: null, decidedAt: null, expiresAt: null, createdAt: new Date(Date.UTC(2026, 10, 9, 10, 0, 60 - i)),
    run: { id: runId, pipeline: { id: "p", name: `Pipe ${runId}`, company: { id: "c", name: "Co", slug: "co", config: { webhookSecret: "SECRET-CFG", niche: "n" } } } },
  };
}

beforeEach(() => {
  approvalFindMany.mockReset();
  runFindMany.mockReset();
  runFindMany.mockResolvedValue([]);
  approvalFindMany.mockResolvedValue([]);
});

describe("GET /approvals yanıt-anahtar sözleşmesi", () => {
  it("select anahtar kümesi sabit; include yok; geniş ilişki alanları seçilmez", async () => {
    await invoke();
    const arg = approvalFindMany.mock.calls[0][0];
    expect(arg.include).toBeUndefined();
    expect(arg.select).toBe(APPROVAL_LIST_SELECT);
    const sel = arg.select;
    expect(Object.keys(sel).sort()).toEqual([
      "amountUsd", "createdAt", "decidedAt", "decidedBy", "description", "expiresAt",
      "id", "metadata", "run", "runId", "status", "type",
    ]);
    expect(Object.keys(sel.run.select).sort()).toEqual(RUN_KEYS);
    expect(Object.keys(sel.run.select.pipeline.select).sort()).toEqual(PIPELINE_KEYS);
    expect(Object.keys(sel.run.select.pipeline.select.company.select).sort()).toEqual(COMPANY_KEYS);
    for (const k of FORBIDDEN) {
      for (const level of [sel, sel.run.select, sel.run.select.pipeline.select]) expect(level).not.toHaveProperty(k);
    }
  });

  it("düz dizi: onay + iç içe anahtarlar izinli kümeden ibaret; metadata yalnız toolName; sır yok", async () => {
    approvalFindMany.mockResolvedValue([row(1)]);
    const { res } = await invoke();
    const a = res.body[0];
    expect(Object.keys(a).sort()).toEqual(APPROVAL_KEYS);
    expect(Object.keys(a.run).sort()).toEqual(RUN_KEYS);
    expect(Object.keys(a.run.pipeline).sort()).toEqual(PIPELINE_KEYS);
    expect(Object.keys(a.run.pipeline.company).sort()).toEqual(COMPANY_KEYS);
    expect(a.metadata).toEqual({ toolName: "send_email" });
    expect(a.run.pipeline.company.config).toEqual({ niche: "n", webhookSecretSet: true });
    const json = JSON.stringify(res.body);
    for (const bad of ["SECRET-INPUT", "SECRET-NOTE", "SECRET-CFG", "handoffId"]) expect(json).not.toContain(bad);
    for (const k of FORBIDDEN) expect(a).not.toHaveProperty(k);
  });

  it("artifact hâlâ ham metadata.input'tan çıkar (istemci kartı korunur)", async () => {
    const r = row(1);
    r.metadata = { toolName: "send_email", input: { subject: "Konu", body: "Gövde" } } as any;
    approvalFindMany.mockResolvedValue([r]);
    const { res } = await invoke();
    expect(res.body[0].artifact).toMatchObject({ source: "action" });
    expect(JSON.stringify(res.body[0].metadata)).not.toContain("Gövde");
  });

  it("groupBy=run: grup + onay anahtarları aynı dar küme (run onaydan ayrılır)", async () => {
    approvalFindMany.mockResolvedValue([row(1, "run-A"), row(2, "run-A")]);
    const { res } = await invoke({ groupBy: "run" });
    expect(approvalFindMany.mock.calls[0][0].select).toBe(APPROVAL_LIST_SELECT);
    const g = res.body.groups[0];
    expect(Object.keys(g).sort()).toEqual(["approvals", "runId", "runTitle"]);
    expect(g.runTitle).toBe("Pipe run-A");
    expect(Object.keys(g.approvals[0]).sort()).toEqual(APPROVAL_KEYS.filter((k) => k !== "run"));
    expect(g.approvals[0].metadata).toEqual({ toolName: "send_email" });
    expect(JSON.stringify(res.body)).not.toContain("SECRET");
  });

  it("BRA-UX-API-01: details kapalı şema; ham metadata sızmaz; eski alanlar aynen; groupBy'da da", async () => {
    const r = row(1, "run-A");
    r.metadata = { toolName: "send_email", input: { to: "SECRET-INPUT", apiKey: "K" }, note: "SECRET-NOTE" } as any;
    approvalFindMany.mockResolvedValue([r]);
    const flat = await invoke();
    const a = flat.res.body[0];
    expect(a.details).toEqual({
      risk: null,
      permissions: ["send_email"],
      dataTransfer: ["send_email ← girdi alanları: to"],
      reversible: null,
    });
    // mevcut sözleşme birebir
    expect(a.metadata).toEqual({ toolName: "send_email" });
    expect(a.description).toBe("d");
    expect(a.amountUsd).toBeNull();
    for (const bad of ["SECRET-INPUT", "SECRET-NOTE", "apiKey"]) expect(JSON.stringify(flat.res.body)).not.toContain(bad);

    approvalFindMany.mockResolvedValue([r]);
    const grouped = await invoke({ groupBy: "run" });
    expect(Object.keys(grouped.res.body).sort()).toEqual(["groups", "nextCursor"]);
    expect(grouped.res.body.groups[0].approvals[0].details).toEqual(a.details);
    expect(grouped.res.body.groups[0].approvals[0].metadata).toEqual({ toolName: "send_email" });
  });

  it("BRA-UX-API-01: imleç şekilleri değişmez (düz: X-Next-Cursor başlığı, gövde dizi)", async () => {
    approvalFindMany.mockResolvedValue([row(1), row(2), row(3)]);
    const { res, headers } = await invoke({ limit: "2" });
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(typeof headers["X-Next-Cursor"]).toBe("string");
    expect(res.body.every((x: any) => "details" in x)).toBe(true);
  });

  it("BRA-UX-API-01: bozuk metadata -> details null alanlarla, istek düşmez", async () => {
    const r = row(1);
    r.metadata = "bozuk" as any;
    approvalFindMany.mockResolvedValue([r]);
    const { res, nextErr } = await invoke();
    expect(nextErr).toBeUndefined();
    expect(res.body[0].details).toEqual({ risk: null, permissions: null, dataTransfer: null, reversible: null });
    expect(res.body[0].metadata).toEqual({});
  });
});

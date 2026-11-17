/** BRA-UX-API-04 — GET /runs satırına agentName + riskLevel (salt-okur, tek sorgu, sızıntısız). */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Router } from "express";

vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const findMany = vi.hoisted(() => vi.fn());
const count = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/db", () => ({ prisma: { run: { findMany: (...a: unknown[]) => findMany(...a), count: (...a: unknown[]) => count(...a) } } }));
vi.mock("../../../middleware/auth", () => ({ authMiddleware: (_q: unknown, _s: unknown, n: () => void) => n() }));
vi.mock("../../../middleware/rateLimit", () => ({ rateLimit: () => (_q: unknown, _s: unknown, n: () => void) => n() }));
vi.mock("../../pipeline/runner", () => ({ enqueueRun: vi.fn() }));
vi.mock("../../../services/ai-client", async (o) => ({ ...(await o<typeof import("../../../services/ai-client")>()), chatCompletion: vi.fn() }));
vi.mock("../../../services/provider-chain", async (o) => ({ ...(await o<typeof import("../../../services/provider-chain")>()), listTenantProviderLinks: vi.fn().mockResolvedValue([]) }));
vi.mock("../../../services/takeover-config", () => ({ assertKeylessLocalBaseUrl: vi.fn() }));
vi.mock("../handoff.service", () => ({ createHandoff: vi.fn(), claimHandoff: vi.fn(), cancelOpenHandoffForRun: vi.fn(), HandoffClaimError: class extends Error {} }));
vi.mock("../../../config/env", () => ({ env: { NODE_ENV: "development", OFFLINE_MODE: false, CLAUDE_MODEL: "claude-sonnet-4-5" } }));

import { runRouter } from "../router";
import { highestRisk, agentNameOf, MAX_ROW_APPROVALS } from "../row-summary";

function getHandler(router: Router, path: string) {
  const layer = (router as any).stack.find((l: any) => l.route && l.route.path === path && l.route.methods.get);
  return layer.route.stack[layer.route.stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void>;
}
const handler = getHandler(runRouter, "/");
async function invoke(query: Record<string, unknown> = {}, tenantId = "tenant-1") {
  const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
  await handler({ auth: { tenantId, userId: "u", role: "admin" }, query, params: {}, body: {} }, res, () => {});
  return res;
}
function row(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `run-${i}`, pipelineId: "p1", status: "COMPLETED", state: null, resultStatus: null, trigger: "manual", costUsd: null,
    startedAt: null, completedAt: null, heartbeatAt: null, createdAt: new Date(Date.UTC(2026, 10, 9, 10, 0, 60 - i)), updatedAt: new Date(),
    pipeline: { id: "p1", name: "Pipe", company: { id: "c1", name: "Co" } }, steps: [], approvals: [], ...over,
  };
}
const spend = (riskLevel: unknown, extra: Record<string, unknown> = {}) => ({ type: "SPEND", metadata: { toolName: "send_email", riskLevel, ...extra } });

beforeEach(() => { findMany.mockReset(); findMany.mockResolvedValue([]); count.mockReset(); count.mockResolvedValue(0); });

describe("GET /runs — agentName / riskLevel", () => {
  it("ajan adı var -> agentName; adım/ajan yok -> null", async () => {
    findMany.mockResolvedValue([row(1, { steps: [{ agent: { name: "Mia" } }] }), row(2), row(3, { steps: [{ agent: null }] })]);
    const res = await invoke();
    expect(res.body.runs.map((r: any) => r.agentName)).toEqual(["Mia", null, null]);
  });

  it("en yüksek risk seçilir; hiç onay/risk yoksa null; küçük-büyük harf duyarsız", async () => {
    findMany.mockResolvedValue([
      row(1, { approvals: [spend("low"), spend("HIGH"), spend("medium")] }),
      row(2, { approvals: [spend("low"), spend("medium")] }),
      row(3, { approvals: [] }),
      row(4, { approvals: [spend("bogus"), { type: "HANDOFF", metadata: {} }] }),
    ]);
    const res = await invoke();
    expect(res.body.runs.map((r: any) => r.riskLevel)).toEqual(["high", "medium", null, null]);
  });

  it("ham steps/approvals/metadata yanıta sızmaz; yalnız ad + enum", async () => {
    findMany.mockResolvedValue([row(1, { steps: [{ agent: { name: "Mia" } }], approvals: [spend("high", { input: { apiKey: "sk-live-abc" } })] })]);
    const res = await invoke();
    const r = res.body.runs[0];
    expect(r.steps).toBeUndefined();
    expect(r.approvals).toBeUndefined();
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("sk-live-abc");
    expect(text).not.toContain("metadata");
  });

  it("N+1 yok: sayfa boyutundan bağımsız tek findMany; iç içe, sınırlı select", async () => {
    findMany.mockResolvedValue(Array.from({ length: 10 }, (_, i) => row(i)));
    await invoke({ limit: "10" });
    expect(findMany).toHaveBeenCalledTimes(1);
    const sel = findMany.mock.calls[0][0].select;
    expect(sel.steps.take).toBe(1);
    expect(sel.steps.orderBy).toEqual({ stepIndex: "asc" });
    expect(sel.approvals.take).toBe(MAX_ROW_APPROVALS);
    expect(Object.keys(sel.approvals.select).sort()).toEqual(["metadata", "type"]);
    expect(findMany.mock.calls[0][0].include).toBeUndefined();
    expect(count).not.toHaveBeenCalled();
  });

  it("tenant izolasyonu: where ve iç içe ajan süzgeci kiracıyı taşır", async () => {
    await invoke({}, "tenant-A");
    await invoke({}, "tenant-B");
    const [a, b] = findMany.mock.calls.map((c) => c[0]);
    expect(a.where.AND[0]).toEqual({ pipeline: { company: { tenantId: "tenant-A" } } });
    expect(a.select.steps.where.agent).toEqual({ company: { tenantId: "tenant-A" } });
    expect(b.select.steps.where.agent).toEqual({ company: { tenantId: "tenant-B" } });
  });

  it("nextCursor ham satırdan hesaplanır (alan ekleme imleci bozmaz)", async () => {
    findMany.mockResolvedValue([row(1), row(2), row(3)]);
    const res = await invoke({ limit: "2" });
    expect(res.body.runs).toHaveLength(2);
    expect(typeof res.body.nextCursor).toBe("string");
  });
});

describe("row-summary yardımcıları", () => {
  it("highestRisk / agentNameOf kenar durumları", () => {
    expect(highestRisk(undefined)).toBeNull();
    expect(highestRisk([{ type: "SPEND", metadata: null }])).toBeNull();
    expect(highestRisk([{ type: "SPEND", metadata: { gate: "step", risk: "Medium" } }])).toBe("medium");
    expect(agentNameOf(undefined)).toBeNull();
    expect(agentNameOf([{ agent: { name: "" } }])).toBeNull();
  });
});

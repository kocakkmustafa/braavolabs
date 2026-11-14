/**
 * SEC-BRA-05 — her yeni Approval satırı DOĞRUDAN tenantId taşır (NOT NULL'a
 * daralma hazırlığı). Yalnız exact-action damgasına bağlı değil: bayrak kapalı
 * yollar (SPEND damgasız, EXTERNAL_CONTROL, INPUT, HANDOFF) da yazar.
 * Run için: kaynak taraması, tüm `run.create` / `approval.create` çağrıları
 * `tenantId` içerir (yeni bir yazım yolu eklenirse bu test kırılır).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const approvalCreate = vi.hoisted(() => vi.fn());
const createHandoff = vi.hoisted(() => vi.fn());
const resolveViable = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/db", () => ({
  prisma: {
    approval: { create: (...a: unknown[]) => approvalCreate(...a), deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    run: {
      findFirst: async (args: { select: Record<string, boolean> }) => {
        const snap: Record<string, unknown> = {};
        for (const k of Object.keys(args.select)) snap[k] = k === "status" ? "RUNNING" : null;
        return snap;
      },
      updateMany: async () => ({ count: 1 }),
    },
    activityLog: { create: vi.fn().mockResolvedValue({}) },
    toolCall: { create: vi.fn().mockResolvedValue({}) },
    externalConnection: { findFirst: vi.fn().mockResolvedValue({ platform: "n8n", label: "Akış" }) },
    company: { findFirst: vi.fn() },
  },
}));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../services/push", () => ({ notifyTenantUsers: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../../lib/runEvents", () => ({ publishRunEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../run/handoff.service", () => ({
  createHandoff: (...a: unknown[]) => createHandoff(...a),
  resolveViableHandoffTarget: (...a: unknown[]) => resolveViable(...a),
}));

import { executeTool } from "../tool-executor";
import { maybeOpenAutoHandoff } from "../../run/handoff.trigger";
import { ProviderExhaustedError } from "../../../services/provider-chain";

const tool = (name: string) => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
  meta: { requiresApproval: true, riskLevel: "high" as const, moneyTouching: true },
  handler: vi.fn(),
});
const ctx = (extra?: Map<string, never>) => ({
  runId: "run-1", runStepId: "step-1", companyId: "company-a", tenantId: "tenant-a",
  autonomy: "SUPERVISED" as const, ...(extra ? { extraTools: extra } : {}),
});
const created = () => approvalCreate.mock.calls[0][0].data as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  approvalCreate.mockResolvedValue({ id: "appr-1" });
});

describe("Approval.tenantId doğrudan yazılır", () => {
  it("SPEND (damgasız, exact-action bayrağı kapalı)", async () => {
    const t = tool("ad_spend_x");
    const res = await executeTool(t.name, { budgetUsd: 5 }, ctx(new Map([[t.name, t as never]])));
    expect(res.status).toBe("PENDING_APPROVAL");
    expect(created().tenantId).toBe("tenant-a");
    expect(created().type).toBe("SPEND");
  });

  it("EXTERNAL_CONTROL", async () => {
    await executeTool("external_control", { connectionId: "c1", action: "PAUSE", targetId: "wf" }, ctx());
    expect(created().type).toBe("EXTERNAL_CONTROL");
    expect(created().tenantId).toBe("tenant-a");
  });

  it("INPUT (ask_user)", async () => {
    await executeTool("ask_user", { question: "Hangisi?" }, ctx());
    expect(created().type).toBe("INPUT");
    expect(created().tenantId).toBe("tenant-a");
  });

  it("HANDOFF (otomatik devir) defterin tenantId'sini taşır", async () => {
    createHandoff.mockResolvedValue({ id: "h1", tenantId: "tenant-a" });
    resolveViable.mockResolvedValue({ provider: "OPENAI", model: "m" });
    const err = new ProviderExhaustedError("FAILOVER", 429, "ANTHROPIC" as never, "claude", new Error("x"));
    await maybeOpenAutoHandoff("run-1", err);
    expect(created().type).toBe("HANDOFF");
    expect(created().tenantId).toBe("tenant-a");
  });
});

describe("kaynak taraması: her run.create / approval.create tenantId yazar", () => {
  const root = join(__dirname, "../../..");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (n !== "__tests__" && n !== "node_modules") walk(p); }
      else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) files.push(p);
    }
  };
  walk(root);

  it("Run (4 yol) ve Approval (5 yol) oluşturucuların veri bloğunda tenantId var", () => {
    const re = /\b(?:prisma|tx)\.(run|approval)\.create\(\{/g;
    const found: Record<string, number> = { run: 0, approval: 0 };
    const missing: string[] = [];
    for (const f of files) {
      const s = readFileSync(f, "utf8");
      for (const m of s.matchAll(re)) {
        found[m[1]]++;
        const block = s.slice(m.index!, m.index! + 1500);
        const end = block.search(/\n\s*\}\);/);
        const body = end > 0 ? block.slice(0, end) : block;
        if (!/tenantId|buildApprovalStamp|\.\.\.\(exactStamp/.test(body)) missing.push(`${f}:${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
    expect(found.run).toBeGreaterThanOrEqual(4);
    expect(found.approval).toBeGreaterThanOrEqual(5);
  });
});

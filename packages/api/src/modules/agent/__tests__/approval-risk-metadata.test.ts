/**
 * BRA-UX-API-01c — executeTool onay satırına `riskLevel` (+ `reversible`) yazar;
 * `deriveApprovalDetails` bunları `details.risk` / `details.reversible` olarak okur.
 * Eski onaylar (alan yok) null kalır; boolean olmayan `reversible` null.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const approvalCreate = vi.hoisted(() => vi.fn());
const connFindFirst = vi.hoisted(() => vi.fn());

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
    externalConnection: { findFirst: (...a: unknown[]) => connFindFirst(...a) },
    company: { findFirst: vi.fn() },
  },
}));
vi.mock("../../../lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../services/push", () => ({ notifyTenantUsers: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../../lib/runEvents", () => ({ publishRunEvent: vi.fn().mockResolvedValue(undefined) }));

import { executeTool } from "../tool-executor";
import { deriveApprovalDetails } from "../../approval/details";

type Meta = { requiresApproval: boolean; riskLevel: "low" | "medium" | "high"; moneyTouching?: boolean };
const customTool = (name: string, meta: Meta) => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
  meta,
  handler: vi.fn(),
});
const ctx = (t: ReturnType<typeof customTool>, autonomy: "SUPERVISED" | "BALANCED" | "AUTONOMOUS" = "SUPERVISED") => ({
  runId: "run-1", runStepId: "step-1", companyId: "company-a", tenantId: "tenant-a",
  autonomy, extraTools: new Map([[t.name, t as never]]),
});
const createdMetadata = () => approvalCreate.mock.calls[0][0].data.metadata as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  approvalCreate.mockResolvedValue({ id: "appr-1" });
  connFindFirst.mockResolvedValue({ platform: "n8n", label: "Akış" });
});

describe("araç kapısı (SPEND): riskLevel + reversible metadata'ya yazılır", () => {
  it("orta riskli, para dışı araç: riskLevel yazılır, reversible alanı YOK → details.reversible null", async () => {
    const t = customTool("edit_doc", { requiresApproval: false, riskLevel: "medium", moneyTouching: false });
    const res = await executeTool(t.name, {}, ctx(t));
    expect(res.status).toBe("PENDING_APPROVAL");
    const m = createdMetadata();
    expect(m.riskLevel).toBe("medium");
    expect("reversible" in m).toBe(false);
    const d = deriveApprovalDetails("SPEND", m);
    expect(d.risk).toBe("medium");
    expect(d.reversible).toBeNull();
  });

  it("para harcayan araç: riskLevel yazılır, reversible=false → details.reversible false", async () => {
    const t = customTool("ad_spend_x", { requiresApproval: true, riskLevel: "high", moneyTouching: true });
    await executeTool(t.name, { budgetUsd: 5 }, ctx(t, "AUTONOMOUS"));
    const m = createdMetadata();
    expect(m).toMatchObject({ riskLevel: "high", reversible: false, moneyTouching: true });
    const d = deriveApprovalDetails("SPEND", m);
    expect(d.risk).toBe("high");
    expect(d.reversible).toBe(false);
  });
});

describe("EXTERNAL_CONTROL: riskLevel registry'den, reversible eyleme göre", () => {
  const input = (action: string) => ({ connectionId: "conn-1", action, targetId: "wf-1" });

  it("TRIGGER geri alınamaz; PAUSE/RESUME birbirinin tersi", async () => {
    const t = customTool("unused", { requiresApproval: false, riskLevel: "low" });
    const expected: Record<string, boolean> = { TRIGGER: false, PAUSE: true, RESUME: true };
    for (const action of Object.keys(expected)) {
      approvalCreate.mockClear();
      const res = await executeTool("external_control", input(action), ctx(t));
      expect(res.status).toBe("PENDING_APPROVAL");
      const m = createdMetadata();
      expect(m).toMatchObject({ toolName: "external_control", action, riskLevel: "high", reversible: expected[action] });
      const d = deriveApprovalDetails("EXTERNAL_CONTROL", m);
      expect(d.risk).toBe("high");
      expect(d.reversible).toBe(expected[action]);
    }
  });
});

describe("deriveApprovalDetails: eski onaylar ve bozuk şekiller null", () => {
  it("riskLevel/reversible alanı olmayan eski SPEND ve EXTERNAL_CONTROL onayı → null", () => {
    expect(deriveApprovalDetails("SPEND", { toolName: "send_email", input: { to: "x" }, moneyTouching: true })).toMatchObject({ risk: null, reversible: null });
    expect(deriveApprovalDetails("EXTERNAL_CONTROL", { toolName: "external_control", connectionId: "c1", action: "PAUSE", targetId: "t1" })).toMatchObject({ risk: null, reversible: null });
  });

  it("riskLevel büyük/küçük harf duyarsız; bilinmeyen/sayı null; reversible yalnız boolean", () => {
    expect(deriveApprovalDetails("SPEND", { toolName: "t", riskLevel: "HIGH" }).risk).toBe("high");
    for (const bad of ["critical", 3, null, {}, ""]) {
      expect(deriveApprovalDetails("SPEND", { toolName: "t", riskLevel: bad }).risk).toBeNull();
    }
    for (const bad of ["true", 1, 0, null, "false", {}]) {
      expect(deriveApprovalDetails("SPEND", { toolName: "t", reversible: bad }).reversible).toBeNull();
    }
    expect(deriveApprovalDetails("SPEND", { toolName: "t", reversible: true }).reversible).toBe(true);
  });

  it("adım kapısı değişmedi: risk metadata.risk'ten, reversible null; INPUT/HANDOFF riskLevel yazılsa da null", () => {
    expect(deriveApprovalDetails("SPEND", { gate: "step", tool: "x", risk: "high", riskLevel: "low", reversible: true }))
      .toMatchObject({ risk: "high", reversible: null });
    expect(deriveApprovalDetails("INPUT", { toolName: "ask_user", riskLevel: "high", reversible: false }))
      .toEqual({ risk: null, permissions: null, dataTransfer: null, reversible: null });
    expect(deriveApprovalDetails("HANDOFF", { handoffId: "h", suggestedProvider: "openai", riskLevel: "high", reversible: false }))
      .toMatchObject({ risk: null, reversible: null });
  });
});

/**
 * D-005 (E5/T4+T7) — dynamic connector tool splice, end-to-end through the
 * REAL executeTool (not a pure-fn shortcut). Covers:
 *
 *   (a) a connector tool passed via request-scoped `extraTools` is RESOLVED
 *       and RUN — the old registry-miss ("not found in registry") is gone;
 *   (b) a high-risk / money connector tool creates an approval row and drives
 *       the run to WAITING_APPROVAL under a SUPERVISED agent (D-005 gate);
 *   (c) a low-risk (read) connector tool runs WITHOUT an approval;
 *   (d) cross-tenant isolation: a connector tool is only reachable via the
 *       per-request map — it is NEVER in the global registry, so it cannot
 *       appear in another tenant's loop.
 *
 * Prisma is mocked so the executor's approval / audit writes are observable
 * without a live DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Prisma mock: only the tables executeTool touches on these paths ──
const approvalCreate = vi.fn();
const runUpdate = vi.fn();
const activityLogCreate = vi.fn();
const toolCallCreate = vi.fn();
const companyFindFirst = vi.fn();

vi.mock("../../../lib/db", () => ({
  prisma: {
    company: { findFirst: (...a: unknown[]) => companyFindFirst(...a) },
    approval: { create: (...a: unknown[]) => approvalCreate(...a) },
    run: { update: (...a: unknown[]) => runUpdate(...a) },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
    toolCall: { create: (...a: unknown[]) => toolCallCreate(...a) },
  },
}));

// Silence side-effect modules.
vi.mock("../../../services/push", () => ({ notifyTenantUsers: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../../lib/runEvents", () => ({ publishRunEvent: vi.fn().mockResolvedValue(undefined) }));

import { executeTool } from "../tool-executor";
import { getTool, getToolNames, type ToolDefinition } from "../registry";
import { buildChatToolDefs } from "../claude";
import { deriveConnectorToolMeta } from "../../marketplace/connector-tool-risk";
import { makeConnectorToolName } from "../../marketplace/dynamic-tools";

const TENANT_A = "tenant-a";
const COMPANY_A = "company-a";

/** Build a request-scoped connector-tool definition exactly as
 * listConnectorToolsForTenant does (name + derived meta + handler). */
function makeConnectorTool(
  slug: string,
  remoteName: string,
  description: string,
  handler: (args: unknown) => Promise<unknown>,
): ToolDefinition {
  return {
    name: makeConnectorToolName(slug, remoteName),
    description,
    inputSchema: { type: "object", properties: {} },
    meta: deriveConnectorToolMeta(remoteName, description),
    handler,
  };
}

const baseCtx = {
  runId: "run-1",
  runStepId: "step-1",
  companyId: COMPANY_A,
  tenantId: TENANT_A,
};

beforeEach(() => {
  approvalCreate.mockReset();
  runUpdate.mockReset();
  activityLogCreate.mockReset();
  toolCallCreate.mockReset();
  companyFindFirst.mockReset();
  approvalCreate.mockResolvedValue({ id: "appr-1" });
  runUpdate.mockResolvedValue({});
  activityLogCreate.mockResolvedValue({});
  toolCallCreate.mockResolvedValue({});
});

describe("(a) connector tool resolves + runs via extraTools (no registry-miss)", () => {
  it("runs a low-risk connector tool from the request-scoped map", async () => {
    const handler = vi.fn().mockResolvedValue({ items: [1, 2, 3] });
    const tool = makeConnectorTool("acme", "list_items", "List all items", handler);
    const extraTools = new Map([[tool.name, tool]]);

    const res = await executeTool(tool.name, {}, { ...baseCtx, autonomy: "SUPERVISED", extraTools });

    expect(res.status).toBe("COMPLETED");
    expect(res.error).toBeUndefined();
    expect(handler).toHaveBeenCalledOnce();
    // No approval for a pure read even under SUPERVISED.
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it("FAILS with registry-miss when the tool is NOT in extraTools and NOT global", async () => {
    const res = await executeTool(
      makeConnectorToolName("acme", "list_items"),
      {},
      { ...baseCtx, autonomy: "SUPERVISED" }, // no extraTools
    );
    expect(res.status).toBe("FAILED");
    expect(res.error).toMatch(/not found in registry/);
  });
});

describe("(b) high-risk / money connector tool is gated (approval row + WAITING_APPROVAL)", () => {
  it("a delete tool pauses under SUPERVISED", async () => {
    const handler = vi.fn();
    const tool = makeConnectorTool("acme", "delete_record", "Delete a record", handler);
    const extraTools = new Map([[tool.name, tool]]);

    const res = await executeTool(tool.name, {}, { ...baseCtx, autonomy: "SUPERVISED", extraTools });

    expect(res.status).toBe("PENDING_APPROVAL");
    expect(res.approvalId).toBe("appr-1");
    expect(approvalCreate).toHaveBeenCalledOnce();
    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "WAITING_APPROVAL" }) }),
    );
    // The handler must NOT run while paused.
    expect(handler).not.toHaveBeenCalled();
  });

  it("a money (charge) tool pauses even under AUTONOMOUS (rule #3)", async () => {
    const handler = vi.fn();
    const tool = makeConnectorTool("stripe", "charge_card", "Charge the card", handler);
    const extraTools = new Map([[tool.name, tool]]);

    const res = await executeTool(tool.name, {}, { ...baseCtx, autonomy: "AUTONOMOUS", extraTools });

    expect(res.status).toBe("PENDING_APPROVAL");
    expect(approvalCreate).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("(c) low-risk connector tool runs without approval at every autonomy", () => {
  for (const autonomy of ["SUPERVISED", "BALANCED", "AUTONOMOUS"] as const) {
    it(`read tool runs under ${autonomy}`, async () => {
      const handler = vi.fn().mockResolvedValue({ ok: true });
      const tool = makeConnectorTool("acme", "get_status", "Get status", handler);
      const extraTools = new Map([[tool.name, tool]]);
      const res = await executeTool(tool.name, {}, { ...baseCtx, autonomy, extraTools });
      expect(res.status).toBe("COMPLETED");
      expect(approvalCreate).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledOnce();
    });
  }
});

describe("splice visibility — buildChatToolDefs surfaces the connector tool to the model", () => {
  it("includes the connector tool def when passed via extraTools", () => {
    const tool = makeConnectorTool("acme", "list_items", "List all items", vi.fn());
    const extraTools = new Map([[tool.name, tool]]);
    const defs = buildChatToolDefs([tool.name], extraTools);
    expect(defs.map((d) => d.name)).toContain(tool.name);
  });

  it("without extraTools the same name resolves to nothing (not global)", () => {
    const name = makeConnectorToolName("acme", "list_items");
    const defs = buildChatToolDefs([name]);
    expect(defs.map((d) => d.name)).not.toContain(name);
  });
});

describe("(d) cross-tenant isolation — connector tools never touch the global registry", () => {
  it("a connector tool is absent from getToolNames() / getTool()", () => {
    const tool = makeConnectorTool("acme", "delete_record", "Delete", vi.fn());
    // Simulate tenant-A's request scope.
    const extraToolsA = new Map([[tool.name, tool]]);
    expect(extraToolsA.has(tool.name)).toBe(true);

    // The global registry must NOT know it — so tenant-B (a fresh request
    // with its own, empty or different extraTools) can never resolve it.
    expect(getTool(tool.name)).toBeUndefined();
    expect(getToolNames()).not.toContain(tool.name);
  });

  it("tenant-B's request (different extraTools) cannot resolve tenant-A's tool → registry-miss", async () => {
    const toolA = makeConnectorTool("acme", "delete_record", "Delete", vi.fn());
    // Tenant-B has its own connector map that does NOT include tenant-A's tool.
    const extraToolsB = new Map([
      [
        makeConnectorToolName("other", "list_items"),
        makeConnectorTool("other", "list_items", "List", vi.fn()),
      ],
    ]);

    const res = await executeTool(
      toolA.name,
      {},
      { runId: "run-b", runStepId: "step-b", companyId: "company-b", tenantId: "tenant-b", extraTools: extraToolsB },
    );
    // Not in tenant-B's map, not global → FAILED registry-miss (isolated).
    expect(res.status).toBe("FAILED");
    expect(res.error).toMatch(/not found in registry/);
  });
});

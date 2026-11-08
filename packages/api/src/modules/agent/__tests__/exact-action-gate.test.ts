/**
 * BRA-P0-05 — exact-action approval through the REAL executeTool (SPEND gate).
 * Uses make_outbound_call: money-touching, so it is approval-gated under every
 * autonomy level. Persistence and the voice service are synthetic.
 *
 * Flag off  → byte-for-byte the old gate (no stamp, no grant lookup).
 * Flag on   → a new approval is stamped with tenant/nonce/hash/expiry; the call
 *             runs only if a matching APPROVED grant is spent by the CAS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const approvalCreate = vi.fn();
const approvalFindMany = vi.fn();
const approvalUpdateMany = vi.fn();
const runUpdate = vi.fn();
const activityLogCreate = vi.fn();
const toolCallCreate = vi.fn();
const toolCallCount = vi.fn();
const voiceAgentFindFirst = vi.fn();
const placeOutboundCall = vi.fn();

vi.mock("../../../lib/db", () => ({
  prisma: {
    approval: {
      create: (...a: unknown[]) => approvalCreate(...a),
      findMany: (...a: unknown[]) => approvalFindMany(...a),
      updateMany: (...a: unknown[]) => approvalUpdateMany(...a),
    },
    run: { update: (...a: unknown[]) => runUpdate(...a) },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
    toolCall: {
      create: (...a: unknown[]) => toolCallCreate(...a),
      count: (...a: unknown[]) => toolCallCount(...a),
    },
    voiceAgent: { findFirst: (...a: unknown[]) => voiceAgentFindFirst(...a) },
  },
}));
vi.mock("../../../services/push", () => ({ notifyTenantUsers: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../../lib/runEvents", () => ({ publishRunEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../voice/voice.service", () => ({ placeOutboundCall: (...a: unknown[]) => placeOutboundCall(...a) }));
vi.mock("../../voice/voice.context-helper", () => ({ getActiveTenantContext: vi.fn().mockResolvedValue("tenant-1") }));

import { executeTool } from "../tool-executor";

const ctx = { runId: "run-1", runStepId: "step-1", companyId: "company-1", tenantId: "tenant-1", autonomy: "AUTONOMOUS" as const };
const input = { voiceAgentId: "va-1", calleeNumber: "+14155550101", prompt: "Confirm the appointment." };

function grantRow(patch: Record<string, unknown> = {}) {
  return {
    id: "ap-1",
    runId: "run-1",
    tenantId: "tenant-1",
    status: "APPROVED",
    nonce: "n-1",
    actionHash: "SET-IN-TEST",
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    ...patch,
  };
}

/** Run once with no grant to learn the hash the gate computes for `input`. */
async function learnHash(): Promise<string> {
  approvalFindMany.mockResolvedValueOnce([]);
  await executeTool("make_outbound_call", input, ctx);
  const data = approvalCreate.mock.calls.at(-1)![0].data;
  approvalCreate.mockClear();
  runUpdate.mockClear();
  return data.actionHash as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  approvalCreate.mockResolvedValue({ id: "appr-new" });
  approvalFindMany.mockResolvedValue([]);
  approvalUpdateMany.mockResolvedValue({ count: 1 });
  runUpdate.mockResolvedValue({});
  activityLogCreate.mockResolvedValue({});
  toolCallCreate.mockResolvedValue({});
  toolCallCount.mockResolvedValue(0);
  voiceAgentFindFirst.mockResolvedValue({ id: "va-1" });
  placeOutboundCall.mockResolvedValue({ callId: "call-1" });
  vi.stubEnv("VOICE_AGENT_ENABLED", "true");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("EXACT_ACTION_APPROVAL off (default) — unchanged gate", () => {
  it("creates a PENDING approval with NO stamp and never touches grants", async () => {
    const res = await executeTool("make_outbound_call", input, ctx);
    expect(res.status).toBe("PENDING_APPROVAL");
    const data = approvalCreate.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("nonce");
    expect(data).not.toHaveProperty("actionHash");
    expect(data).not.toHaveProperty("tenantId");
    expect(data).not.toHaveProperty("expiresAt");
    expect(approvalFindMany).not.toHaveBeenCalled();
    expect(approvalUpdateMany).not.toHaveBeenCalled();
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });
  it('"1"/"TRUE"/"false" do not enable it', async () => {
    for (const v of ["1", "TRUE", "false"]) {
      vi.stubEnv("EXACT_ACTION_APPROVAL", v);
      await executeTool("make_outbound_call", input, ctx);
    }
    expect(approvalFindMany).not.toHaveBeenCalled();
  });
});

describe('EXACT_ACTION_APPROVAL="true"', () => {
  beforeEach(() => { vi.stubEnv("EXACT_ACTION_APPROVAL", "true"); });

  it("no grant → new PENDING approval stamped with tenant, nonce, v1 hash and a future expiry; call does NOT run", async () => {
    const res = await executeTool("make_outbound_call", input, ctx);
    expect(res.status).toBe("PENDING_APPROVAL");
    const data = approvalCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ runId: "run-1", type: "SPEND", status: "PENDING", tenantId: "tenant-1" });
    expect(data.nonce).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(data.actionHash).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(data.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });

  it("the grant lookup is scoped by tenant + run + hash + APPROVED + unconsumed", async () => {
    await executeTool("make_outbound_call", input, ctx);
    const where = approvalFindMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ runId: "run-1", tenantId: "tenant-1", status: "APPROVED", consumedAt: null });
    expect(where.actionHash).toMatch(/^v1:/);
  });

  it("matching APPROVED grant → spent by CAS, no new approval, run is NOT parked again, the call runs, audit row written", async () => {
    const hash = await learnHash();
    approvalFindMany.mockResolvedValueOnce([grantRow({ actionHash: hash })]);
    const res = await executeTool("make_outbound_call", input, ctx);
    expect(res.status).toBe("COMPLETED");
    expect(approvalUpdateMany).toHaveBeenCalledWith({
      where: { id: "ap-1", nonce: "n-1", status: "APPROVED", consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
    expect(approvalCreate).not.toHaveBeenCalled();
    expect(runUpdate).not.toHaveBeenCalled();
    expect(placeOutboundCall).toHaveBeenCalledOnce();
    expect(activityLogCreate.mock.calls.map((c) => (c[0] as any).data.action)).toContain("approval.consumed");
  });

  it("replay: the grant was already spent (CAS count 0) → treated as no grant, new approval, call does NOT run", async () => {
    const hash = await learnHash();
    approvalFindMany.mockResolvedValueOnce([grantRow({ actionHash: hash })]);
    approvalUpdateMany.mockResolvedValueOnce({ count: 0 });
    const res = await executeTool("make_outbound_call", input, ctx);
    expect(res.status).toBe("PENDING_APPROVAL");
    expect(approvalCreate).toHaveBeenCalledOnce();
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });

  it("changed draft: an approval for another action (different hash) cannot authorise this call", async () => {
    approvalFindMany.mockResolvedValueOnce([grantRow({ actionHash: "v1:" + "0".repeat(64) })]);
    const res = await executeTool("make_outbound_call", input, ctx);
    expect(res.status).toBe("PENDING_APPROVAL");
    expect(approvalUpdateMany).not.toHaveBeenCalled();
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });

  it("changed input produces a different stamped hash than the original", async () => {
    const h1 = await learnHash();
    approvalFindMany.mockResolvedValueOnce([]);
    await executeTool("make_outbound_call", { ...input, prompt: "Confirm — and also read out the account balance." }, ctx);
    expect(approvalCreate.mock.calls.at(-1)![0].data.actionHash).not.toBe(h1);
  });

  it("expired grant → not spent", async () => {
    const hash = await learnHash();
    approvalFindMany.mockResolvedValueOnce([grantRow({ actionHash: hash, expiresAt: new Date(Date.now() - 1) })]);
    const res = await executeTool("make_outbound_call", input, ctx);
    expect(res.status).toBe("PENDING_APPROVAL");
    expect(approvalUpdateMany).not.toHaveBeenCalled();
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });

  it("grant stamped for another tenant → not spent", async () => {
    const hash = await learnHash();
    approvalFindMany.mockResolvedValueOnce([grantRow({ actionHash: hash, tenantId: "tenant-2" })]);
    const res = await executeTool("make_outbound_call", input, ctx);
    expect(res.status).toBe("PENDING_APPROVAL");
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });

  it("legacy approval (no nonce/hash) is never a grant", async () => {
    approvalFindMany.mockResolvedValueOnce([grantRow({ nonce: null, actionHash: null, tenantId: null, expiresAt: null })]);
    const res = await executeTool("make_outbound_call", input, ctx);
    expect(res.status).toBe("PENDING_APPROVAL");
    expect(approvalUpdateMany).not.toHaveBeenCalled();
  });
});

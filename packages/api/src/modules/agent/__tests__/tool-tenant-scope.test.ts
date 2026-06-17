import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Prisma client BEFORE importing the module under test so the
// validator predicates hit our stubs instead of a real DB.
const findFirst = {
  contact: vi.fn(),
  deal: vi.fn(),
  outreachSequence: vi.fn(),
  draft: vi.fn(),
  voiceAgent: vi.fn(),
};
vi.mock("../../../lib/db", () => ({
  prisma: {
    contact: { findFirst: (...a: unknown[]) => findFirst.contact(...a) },
    deal: { findFirst: (...a: unknown[]) => findFirst.deal(...a) },
    outreachSequence: { findFirst: (...a: unknown[]) => findFirst.outreachSequence(...a) },
    draft: { findFirst: (...a: unknown[]) => findFirst.draft(...a) },
    voiceAgent: { findFirst: (...a: unknown[]) => findFirst.voiceAgent(...a) },
  },
}));

import { enforceTenantScopedSecondaryIds } from "../tool-executor";

const T = "tenant-1";

beforeEach(() => {
  for (const fn of Object.values(findFirst)) fn.mockReset();
});

describe("enforceTenantScopedSecondaryIds — fail-closed tripwire (FINDINGS H2)", () => {
  it("passes when no id-shaped fields are present", async () => {
    await expect(enforceTenantScopedSecondaryIds({ query: "hi", limit: 5 }, T, "recall_memory")).resolves.toBeUndefined();
  });

  it("ignores known-safe id fields (companyId, voiceId, tenantId) without a DB hit", async () => {
    await expect(
      enforceTenantScopedSecondaryIds({ companyId: "c1", voiceId: "el-rachel", tenantId: T }, T, "synthesize_voice"),
    ).resolves.toBeUndefined();
    expect(findFirst.contact).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED on an unrecognised *Id field (e.g. a new tool's pipelineId)", async () => {
    await expect(
      enforceTenantScopedSecondaryIds({ pipelineId: "p1" }, T, "future_tool"),
    ).rejects.toThrow(/Unrecognised tenant-scoped id field "pipelineId"/);
  });

  it("does not treat 'id', 'uuid', or 'valid' as tenant id fields", async () => {
    await expect(
      enforceTenantScopedSecondaryIds({ id: "x", uuid: "y", valid: true }, T, "t"),
    ).resolves.toBeUndefined();
  });
});

describe("enforceTenantScopedSecondaryIds — validator path", () => {
  it("allows a contactId that belongs to the tenant", async () => {
    findFirst.contact.mockResolvedValue({ id: "ct1" });
    await expect(enforceTenantScopedSecondaryIds({ contactId: "ct1" }, T, "crm")).resolves.toBeUndefined();
    expect(findFirst.contact).toHaveBeenCalledOnce();
  });

  it("rejects a contactId that belongs to a different tenant", async () => {
    findFirst.contact.mockResolvedValue(null);
    await expect(enforceTenantScopedSecondaryIds({ contactId: "victim" }, T, "crm")).rejects.toThrow(
      /Tenant isolation violation: contactId/,
    );
  });

  it("validates a voiceAgentId against VoiceAgent→company→tenant", async () => {
    findFirst.voiceAgent.mockResolvedValue(null);
    await expect(
      enforceTenantScopedSecondaryIds({ voiceAgentId: "va-other" }, T, "make_outbound_call"),
    ).rejects.toThrow(/Tenant isolation violation: voiceAgentId/);
    expect(findFirst.voiceAgent).toHaveBeenCalledOnce();
  });

  it("validates multiple id fields and rejects if any is foreign", async () => {
    findFirst.contact.mockResolvedValue({ id: "ct1" });
    findFirst.deal.mockResolvedValue(null);
    await expect(
      enforceTenantScopedSecondaryIds({ contactId: "ct1", dealId: "d-foreign" }, T, "crm"),
    ).rejects.toThrow(/dealId/);
  });
});

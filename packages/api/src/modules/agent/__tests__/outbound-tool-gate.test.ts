/**
 * B-06 — outbound-contact agent tools through the REAL executeTool.
 *
 * While a feature flag is off the executor refuses the tool before tenant
 * scoping, approval rows or the handler — so nothing approvable reaches the
 * mobile/web approvals queue. With the flag "true" the previous path returns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const approvalCreate = vi.fn();
const runUpdate = vi.fn();
const activityLogCreate = vi.fn();
const toolCallCreate = vi.fn();
const toolCallCount = vi.fn();
const voiceAgentFindFirst = vi.fn();
const sequenceFindFirst = vi.fn();
const contactFindFirst = vi.fn();
const enrollmentCreate = vi.fn();

vi.mock("../../../lib/db", () => ({
  prisma: {
    approval: { create: (...a: unknown[]) => approvalCreate(...a) },
    run: { update: (...a: unknown[]) => runUpdate(...a) },
    activityLog: { create: (...a: unknown[]) => activityLogCreate(...a) },
    toolCall: {
      create: (...a: unknown[]) => toolCallCreate(...a),
      count: (...a: unknown[]) => toolCallCount(...a),
    },
    voiceAgent: { findFirst: (...a: unknown[]) => voiceAgentFindFirst(...a) },
    outreachSequence: { findFirst: (...a: unknown[]) => sequenceFindFirst(...a) },
    contact: { findFirst: (...a: unknown[]) => contactFindFirst(...a) },
    outreachEnrollment: { create: (...a: unknown[]) => enrollmentCreate(...a) },
  },
}));
vi.mock("../../../services/push", () => ({ notifyTenantUsers: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../../lib/runEvents", () => ({ publishRunEvent: vi.fn().mockResolvedValue(undefined) }));

import { executeTool } from "../tool-executor";
import { getTool } from "../registry";

const ctx = { runId: "run-1", runStepId: "step-1", companyId: "company-1", tenantId: "tenant-1" };
const callInput = { voiceAgentId: "va-1", calleeNumber: "+14155550101", prompt: "Confirm the appointment." };
const enrollInput = { sequenceId: "seq-1", contactId: "contact-1" };

beforeEach(() => {
  vi.clearAllMocks();
  approvalCreate.mockResolvedValue({ id: "appr-1" });
  runUpdate.mockResolvedValue({});
  activityLogCreate.mockResolvedValue({});
  toolCallCreate.mockResolvedValue({});
  toolCallCount.mockResolvedValue(0);
  voiceAgentFindFirst.mockResolvedValue({ id: "va-1" });
  sequenceFindFirst.mockResolvedValue({ id: "seq-1" });
  contactFindFirst.mockResolvedValue({ id: "contact-1" });
  enrollmentCreate.mockResolvedValue({ id: "enr-1" });
  vi.stubEnv("OUTBOUND_EMAIL_ENABLED", "false");
  vi.stubEnv("OUTREACH_SEQUENCES_ENABLED", "false");
  vi.stubEnv("VOICE_AGENT_ENABLED", "false");
});

afterEach(() => { vi.unstubAllEnvs(); });

function expectNothingQueuedOrRun() {
  expect(voiceAgentFindFirst).not.toHaveBeenCalled();
  expect(sequenceFindFirst).not.toHaveBeenCalled();
  expect(approvalCreate).not.toHaveBeenCalled();
  expect(runUpdate).not.toHaveBeenCalled();
  expect(enrollmentCreate).not.toHaveBeenCalled();
}

describe("make_outbound_call — B-06 gate", () => {
  it.each(["SUPERVISED", "BALANCED", "AUTONOMOUS"] as const)(
    "is refused under %s without creating an approval row",
    async (autonomy) => {
      const res = await executeTool("make_outbound_call", callInput, { ...ctx, autonomy });
      expect(res.status).toBe("FAILED");
      expect(res.error).toMatch(/^VOICE_AGENT_DISABLED:/);
      expectNothingQueuedOrRun();
    },
  );

  it("returns to the approval gate when VOICE_AGENT_ENABLED=\"true\"", async () => {
    vi.stubEnv("VOICE_AGENT_ENABLED", "true");
    const res = await executeTool("make_outbound_call", callInput, { ...ctx, autonomy: "AUTONOMOUS" });
    expect(res.status).toBe("PENDING_APPROVAL");
    expect(approvalCreate).toHaveBeenCalledOnce();
  });
});

describe("email_send_sequence — B-06 gate", () => {
  it.each([
    ["false", "false", "OUTREACH_SEQUENCES_DISABLED"],
    ["false", "true", "OUTREACH_SEQUENCES_DISABLED"],
    ["true", "false", "EMAIL_SENDING_DISABLED"],
  ])("outreach=%s email=%s is refused with %s", async (outreach, email, code) => {
    vi.stubEnv("OUTREACH_SEQUENCES_ENABLED", outreach);
    vi.stubEnv("OUTBOUND_EMAIL_ENABLED", email);
    const res = await executeTool("email_send_sequence", enrollInput, { ...ctx, autonomy: "AUTONOMOUS" });
    expect(res.status).toBe("FAILED");
    expect(res.error).toMatch(new RegExp(`^${code}:`));
    expectNothingQueuedOrRun();
  });

  it("handler also refuses when called directly (ungoverned paths)", async () => {
    await expect(getTool("email_send_sequence")!.handler(enrollInput))
      .rejects.toMatchObject({ statusCode: 422, code: "OUTREACH_SEQUENCES_DISABLED" });
    expect(enrollmentCreate).not.toHaveBeenCalled();
  });

  it("enrolls as before when both flags are \"true\"", async () => {
    vi.stubEnv("OUTREACH_SEQUENCES_ENABLED", "true");
    vi.stubEnv("OUTBOUND_EMAIL_ENABLED", "true");
    const res = await executeTool("email_send_sequence", enrollInput, { ...ctx, autonomy: "AUTONOMOUS" });
    expect(res.status).toBe("COMPLETED");
    expect(res.output).toEqual({ enrollmentId: "enr-1", status: "ACTIVE" });
    expect(enrollmentCreate).toHaveBeenCalledOnce();
  });
});

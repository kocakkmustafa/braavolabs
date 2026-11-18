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
    run: {
      // 02c-3: transitionRun (findFirst + updateMany CAS), adapted onto the same spy.
      findFirst: async () => ({ status: "RUNNING" }),
      updateMany: async (a: { where: unknown; data: unknown }) => { runUpdate({ where: a.where, data: a.data }); return { count: 1 }; },
    },
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

describe("deploy / merge connector tools — BRA-P1-03c gate", () => {
  const handler = vi.fn();
  const mk = (name: string, description = "") => new Map([[name, {
    name, description, inputSchema: { type: "object" as const, properties: {} },
    meta: { requiresApproval: true, riskLevel: "high" as const, moneyTouching: false },
    handler: (...a: unknown[]) => handler(...a),
  }]]);

  beforeEach(() => { handler.mockReset(); handler.mockResolvedValue({ ok: true }); vi.stubEnv("DEPLOY_MERGE_TOOLS_ENABLED", "false"); });

  it.each(["gh__merge_pull_request", "GH__MERGE_PR", "vc__DeployProd", "x__deployprod"])(
    "%s is refused under every autonomy, handler never runs, no approval row",
    async (name) => {
      for (const autonomy of ["SUPERVISED", "BALANCED", "AUTONOMOUS"] as const) {
        const res = await executeTool(name, {}, { ...ctx, autonomy, extraTools: mk(name) });
        expect(res.status).toBe("FAILED");
        expect(res.error).toMatch(/^DEPLOY_MERGE_TOOLS_DISABLED: /);
        expect(res.error).not.toMatch(/token|secret|key/i);
      }
      expect(handler).not.toHaveBeenCalled();
      expect(approvalCreate).not.toHaveBeenCalled();
    },
  );

  it("a vague name with a deploy description is refused; unset flag too", async () => {
    vi.unstubAllEnvs();
    delete process.env.DEPLOY_MERGE_TOOLS_ENABLED;
    const res = await executeTool("x__run", {}, { ...ctx, autonomy: "AUTONOMOUS", extraTools: mk("x__run", "Deploy the app to production") });
    expect(res.error).toMatch(/^DEPLOY_MERGE_TOOLS_DISABLED:/);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(["SUPERVISED", "BALANCED", "AUTONOMOUS"] as const)(
    "flag on, %s: still needs a human approval; handler does not run",
    async (autonomy) => {
      vi.stubEnv("DEPLOY_MERGE_TOOLS_ENABLED", "true");
      // meta deliberately LOW/no-approval: the classifier must force the gate.
      const tools = new Map([["gh__merge_pull_request", {
        name: "gh__merge_pull_request", description: "", inputSchema: { type: "object" as const, properties: {} },
        meta: { requiresApproval: false, riskLevel: "low" as const },
        remote: { name: "merge_pull_request", description: "Merges a PR", connectorSlug: "gh", connectorName: "GitHub" },
        handler: (...a: unknown[]) => handler(...a),
      }]]);
      const res = await executeTool("gh__merge_pull_request", {}, { ...ctx, autonomy, extraTools: tools });
      expect(res.status).toBe("PENDING_APPROVAL");
      expect(approvalCreate).toHaveBeenCalledOnce();
      const md = approvalCreate.mock.calls[0][0].data.metadata;
      expect(md.riskLevel).toBe("high");
      expect(md.moneyTouching).toBe(false);
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("connector slug/name taints all its tools (fail closed); look-alike connectors do not", async () => {
    vi.stubEnv("DEPLOY_MERGE_TOOLS_ENABLED", "false");
    const mkC = (slug: string, cname: string) => new Map([[`mcp_${slug}_list_items`, {
      name: `mcp_${slug}_list_items`, description: `[${cname}] Lists items`,
      inputSchema: { type: "object" as const, properties: {} },
      meta: { requiresApproval: false, riskLevel: "low" as const, moneyTouching: false },
      remote: { name: "list_items", description: "Lists items", connectorSlug: slug, connectorName: cname },
      handler: (...a: unknown[]) => handler(...a),
    }]]);
    const blocked = await executeTool("mcp_deployer_list_items", {}, { ...ctx, autonomy: "AUTONOMOUS", extraTools: mkC("deployer", "Deployer") });
    expect(blocked.error).toMatch(/^DEPLOY_MERGE_TOOLS_DISABLED:/);
    expect(handler).not.toHaveBeenCalled();
    for (const [slug, cname] of [["mergeable-tools", "Mergeable Tools"], ["emergency-contacts", "Emergency Contacts"]]) {
      const ok = await executeTool(`mcp_${slug}_list_items`, {}, { ...ctx, autonomy: "AUTONOMOUS", extraTools: mkC(slug, cname) });
      expect(ok.status, slug).toBe("COMPLETED");
    }
  });

  it("classifies the remote name/description, not the connector prefix or truncated display text", async () => {
    vi.stubEnv("DEPLOY_MERGE_TOOLS_ENABLED", "false");
    const benign = new Map([["mcp_deploybot_list_items", {
      name: "mcp_deploybot_list_items", description: "[Deploy Bot] " + "x".repeat(1000),
      inputSchema: { type: "object" as const, properties: {} },
      meta: { requiresApproval: false, riskLevel: "low" as const, moneyTouching: false },
      remote: { name: "list_items", description: "Lists items", connectorSlug: "deploybot", connectorName: "Deploy Bot" },
      handler: (...a: unknown[]) => handler(...a),
    }]]);
    // Connector name "Deploy Bot" taints the tool (accepted fail-closed side effect).
    const ok = await executeTool("mcp_deploybot_list_items", {}, { ...ctx, autonomy: "AUTONOMOUS", extraTools: benign });
    expect(ok.error).toMatch(/^DEPLOY_MERGE_TOOLS_DISABLED:/);
    const hidden = new Map([["mcp_x_run", {
      name: "mcp_x_run", description: "[X] " + "y".repeat(1000), inputSchema: { type: "object" as const, properties: {} },
      meta: { requiresApproval: true, riskLevel: "high" as const, moneyTouching: false },
      remote: { name: "run", description: "y".repeat(1500) + " then deploy to production" },
      handler: (...a: unknown[]) => handler(...a),
    }]]);
    handler.mockClear();
    const res = await executeTool("mcp_x_run", {}, { ...ctx, autonomy: "AUTONOMOUS", extraTools: hidden });
    expect(res.error).toMatch(/^DEPLOY_MERGE_TOOLS_DISABLED:/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("records a refusal row without input when a run step exists", async () => {
    await executeTool("gh__merge_pr", { secret: "s3cr3t" }, { ...ctx, runStepId: "step-1", autonomy: "AUTONOMOUS", extraTools: mk("gh__merge_pr") });
    expect(toolCallCreate).toHaveBeenCalledOnce();
    const data = toolCallCreate.mock.calls[0][0].data;
    expect(data.status).toBe("FAILED");
    expect(JSON.stringify(data)).not.toContain("s3cr3t");
  });
});

import { expect, test } from "@playwright/test";
import { API } from "./helpers";
import { fakeLlmRequests, resetFakeLlm } from "./support/fake-llm-client";
import {
  createAgent, createCompany, createPipeline, getRun, newPaidTenant, startRun, useFakeLlmProvider, waitForRun,
} from "./support/journey";

/**
 * BRA-P0-10 reference journey 3 (negative) — an agent cannot write to the outside world unapproved.
 * Gate flags (OUTREACH_SEQUENCES_ENABLED / OUTBOUND_EMAIL_ENABLED / VOICE_AGENT_ENABLED) are NOT set in the
 * E2E env, so they are off. Two proofs:
 *  1. gated tools are refused with their 422-class code BEFORE any approval row or handler;
 *  2. a money-touching tool stops at a PENDING approval row; it is never executed, before or after rejection.
 */
test.describe("negative: unapproved outbound writes are refused", () => {
  test("gated outbound tools (email sequence, outbound call) are refused with their gate code and queue nothing", async ({ request }) => {
    await resetFakeLlm();
    const t = await newPaidTenant(request);
    await useFakeLlmProvider(request, t);
    const company = await createCompany(request, t);
    await createAgent(request, t, company.id, {
      name: "E2E Outreach", role: "outreach_agent",
      // AUTONOMOUS: the strongest setting still cannot get through the gate.
      systemPrompt: "[e2e:outbound-gated] You contact people.",
      tools: ["email_send_sequence", "make_outbound_call"],
    });
    const agents = await request.get(`${API}/companies/${company.id}/agents`, { headers: t.headers });
    const agentId = ((await agents.json()) as Array<{ id: string }>)[0]!.id;
    const patched = await request.patch(`${API}/companies/${company.id}/agents/${agentId}`, {
      headers: t.headers, data: { autonomy: "AUTONOMOUS" },
    });
    expect(patched.status()).toBe(200);

    const pipeline = await createPipeline(request, t, company.id, "outreach_agent");
    const started = await startRun(request, t, pipeline.id);
    const run = await waitForRun(request, t, started.id, ["COMPLETED", "FAILED"]);
    expect(run.status, `run error: ${run.error ?? run.steps[0]?.error}`).toBe("COMPLETED");

    // Evidence 1: the model's follow-up turn received the gate codes as the tool results.
    const seen = await fakeLlmRequests();
    expect(seen).toHaveLength(2);
    const toolResults = seen[1]!.messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
    expect(toolResults).toContain("OUTREACH_SEQUENCES_DISABLED");
    expect(toolResults).toContain("VOICE_AGENT_DISABLED");

    // Evidence 2: nothing approvable was queued and no tool call completed.
    const approvals = await request.get(`${API}/approvals`, { headers: t.headers });
    expect(await approvals.json()).toEqual([]);
    expect(run.steps[0]!.toolCalls.filter((c) => c.status === "COMPLETED")).toEqual([]);

    // Evidence 3: the only network peer of the model path is the fake server (it recorded every request);
    // the outreach/voice gates are what stopped the writes (no enrollment, no call placed).
    expect(seen.every((r) => r.path === "/v1/chat/completions")).toBe(true);
  });

  test("a money-touching tool stops at a PENDING approval row and never executes", async ({ request }) => {
    await resetFakeLlm();
    const t = await newPaidTenant(request);
    await useFakeLlmProvider(request, t);
    const company = await createCompany(request, t);
    await createAgent(request, t, company.id, {
      name: "E2E Spender", role: "spender",
      systemPrompt: `[e2e:outbound-approval;companyId=${company.id}] You buy ads.`,
      tools: ["ad_spend"],
    });
    const pipeline = await createPipeline(request, t, company.id, "spender");
    const started = await startRun(request, t, pipeline.id);

    // The gate writes a PENDING SPEND approval row; poll the queue (run status is not the signal:
    // the paused tool result is handed back to the model, which then ends its turn).
    let pending: Array<{ id: string; status: string; type: string }> = [];
    for (let i = 0; i < 60 && pending.length === 0; i++) {
      const listed = await request.get(`${API}/approvals`, { headers: t.headers });
      pending = (await listed.json()) as typeof pending;
      if (pending.length === 0) await new Promise((r) => setTimeout(r, 500));
    }
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: "PENDING", type: "SPEND" });
    await waitForRun(request, t, started.id, ["WAITING_APPROVAL", "COMPLETED", "FAILED", "CANCELLED"]);

    // Not executed: the tool call row is the refusal ("paused"), never COMPLETED; the model only saw the pause.
    const paused = await getRun(request, t, started.id);
    const toolCalls = paused.steps.flatMap((s) => s.toolCalls);
    expect(toolCalls.filter((c) => c.toolName === "ad_spend").map((c) => c.status)).toEqual(["FAILED"]);
    expect(toolCalls.find((c) => c.toolName === "ad_spend")!.error).toContain("waiting for spend approval");

    // Rejecting closes the approval and the tool still never runs.
    const decided = await request.post(`${API}/approvals/${pending[0]!.id}/decide`, {
      headers: t.headers, data: { decision: "REJECTED", reason: "e2e negative path" },
    });
    expect(decided.status()).toBe(200);
    const after = await getRun(request, t, started.id);
    expect(after.steps.flatMap((s) => s.toolCalls).filter((c) => c.status === "COMPLETED")).toEqual([]);
    const rejected = await request.get(`${API}/approvals`, { headers: t.headers, params: { status: "REJECTED" } });
    expect(((await rejected.json()) as unknown[]).length).toBe(1);
    expect(await (await request.get(`${API}/approvals`, { headers: t.headers })).json()).toEqual([]);
  });
});

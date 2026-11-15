import { expect, test } from "@playwright/test";
import { API } from "./helpers";
import { fakeLlmRequests, resetFakeLlm } from "./support/fake-llm-client";
import {
  createAgent, createCompany, createPipeline, newPaidTenant, startRun, useFakeLlmProvider, waitForRun,
} from "./support/journey";

/**
 * BRA-P0-10b reference journey 5 — code fix + `create_pull_request`.
 * `create_pull_request` is a DRY-RUN tool (never reaches GitHub, returns prUrl:null) and is also a deploy/merge
 * tool, so the 03c gate (DEPLOY_MERGE_TOOLS_ENABLED, off in E2E) refuses it before any approval row or handler.
 * The flag is NOT turned on here (it is process-global for the API under test); the enabled/dry-run path is
 * covered at unit level (see README). Proves: gate refusal, no approval row, no GitHub egress, and that the
 * receipt does not count the refused PR as evidence.
 */
test("code fix: create_pull_request is refused by the deploy/merge gate and yields no PR evidence", async ({ request }) => {
  await resetFakeLlm();
  const t = await newPaidTenant(request);
  await useFakeLlmProvider(request, t);
  const company = await createCompany(request, t);

  // A GITHUB integration with a FAKE token, so a refusal cannot be blamed on a missing integration.
  const saved = await request.post(`${API}/integrations/${company.id}`, {
    headers: t.headers,
    data: { provider: "GITHUB", credentials: { personalAccessToken: "ghp_e2e_fake_token_not_real", defaultOwner: "e2e-org" } },
  });
  expect(saved.status()).toBe(200);

  await createAgent(request, t, company.id, {
    name: "E2E Code Fixer", role: "code_fixer",
    systemPrompt: `[e2e:code-fix-pr;companyId=${company.id}] You fix bugs and open pull requests.`,
    tools: ["create_pull_request"],
  });
  const pipeline = await createPipeline(request, t, company.id, "code_fixer");
  const started = await startRun(request, t, pipeline.id, { brief: "bu repodaki hatayı düzelt ve PR aç" });
  const run = await waitForRun(request, t, started.id, ["COMPLETED", "FAILED"]);
  expect(run.status, `run error: ${run.error ?? run.steps[0]?.error}`).toBe("COMPLETED");

  // Gate refusal: every create_pull_request row is FAILED with the gate code; none completed.
  const calls = run.steps[0]!.toolCalls.filter((c) => c.toolName === "create_pull_request");
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((c) => c.status === "FAILED" && (c.error ?? "").includes("DEPLOY_MERGE_TOOLS_DISABLED"))).toBe(true);
  expect(run.steps[0]!.toolCalls.filter((c) => c.status === "COMPLETED")).toEqual([]);

  // The model got the gate code back as the tool result; no dry-run request/prUrl was ever produced.
  const seen = await fakeLlmRequests();
  expect(seen).toHaveLength(2);
  const toolResults = seen[1]!.messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
  expect(toolResults).toContain("DEPLOY_MERGE_TOOLS_DISABLED");
  expect(toolResults).not.toContain("dryRun");
  expect(toolResults).not.toContain("prUrl");
  expect(seen.every((r) => r.path === "/v1/chat/completions")).toBe(true);

  // No approval row: nothing approvable reached the queue.
  for (const status of [undefined, "PENDING", "REJECTED", "APPROVED"]) {
    const approvals = await request.get(`${API}/approvals`, { headers: t.headers, params: status ? { status } : {} });
    expect(await approvals.json(), String(status)).toEqual([]);
  }

  // Receipt: receipts are only written with JOB_STATE_DUAL_WRITE=true (off in E2E, like CI/compose), so the run has
  // no receipt at all: nothing can mark it VERIFIED, and no "pr" evidence exists. If a receipt ever appears here
  // it must still carry no "pr" evidence and must not be VERIFIED.
  const receiptRes = await request.get(`${API}/runs/${started.id}/receipt`, { headers: t.headers });
  if (receiptRes.status() === 404) {
    expect(await receiptRes.json()).toEqual({ error: "receipt_not_found" });
  } else {
    expect(receiptRes.status()).toBe(200);
    const receipt = (await receiptRes.json()) as { evidence: Array<{ kind: string }>; resultStatus: string | null };
    expect(receipt.evidence.filter((e) => e.kind === "pr")).toEqual([]);
    expect(receipt.resultStatus).not.toBe("VERIFIED");
  }

  // Code summary: create_pull_request is not a diff/test tool, so there is nothing to summarise.
  const summaryRes = await request.get(`${API}/runs/${started.id}/code-summary`, { headers: t.headers });
  expect(summaryRes.status()).toBe(200);
  const summary = (await summaryRes.json()) as { diff: unknown; tests: unknown };
  expect(summary.diff).toBeNull();
  expect(summary.tests).toBeNull();
  expect(JSON.stringify(summary)).not.toContain("prUrl");
});

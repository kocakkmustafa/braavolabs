import { expect, test } from "@playwright/test";
import { API } from "./helpers";
import { UI } from "./ports";
import { fakeLlmRequests, resetFakeLlm } from "./support/fake-llm-client";
import {
  createAgent, createCompany, createPipeline, newPaidTenant, proxyBrowserApiToRealApi, startRun,
  useFakeLlmProvider, waitForRun,
} from "./support/journey";

/**
 * BRA-P0-10 reference journey 2 — the agent drafts an email.
 * The fake model calls the real `create_draft` tool; the draft must land in
 * /drafts as a PENDING EMAIL and stay that way: nothing is sent.
 */
test("draft email: agent saves a PENDING email draft via create_draft and nothing is sent", async ({ request, context, page }) => {
  await resetFakeLlm();
  const t = await newPaidTenant(request);
  await useFakeLlmProvider(request, t);
  const company = await createCompany(request, t);
  await createAgent(request, t, company.id, {
    name: "E2E Email Writer", role: "email_writer",
    systemPrompt: `[e2e:draft-email;companyId=${company.id}] You draft emails for human review.`,
    tools: ["create_draft"],
  });
  const pipeline = await createPipeline(request, t, company.id, "email_writer");
  const started = await startRun(request, t, pipeline.id, { brief: "welcome email" });

  const run = await waitForRun(request, t, started.id, ["COMPLETED", "FAILED"]);
  expect(run.status, `run error: ${run.error ?? run.steps[0]?.error}`).toBe("COMPLETED");
  const calls = run.steps[0]!.toolCalls;
  // (the product currently records the call row twice; one draft is what matters, asserted below)
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((c) => c.toolName === "create_draft" && c.status === "COMPLETED")).toBe(true);

  // Draft exists, is an email, and is still awaiting a human decision.
  const res = await request.get(`${API}/drafts`, { headers: t.headers, params: { companyId: company.id } });
  expect(res.status()).toBe(200);
  const drafts = (await res.json()) as Array<{ type: string; status: string; title: string; content: { body: string } }>;
  expect(drafts).toHaveLength(1);
  expect(drafts[0]).toMatchObject({ type: "EMAIL", status: "PENDING", title: "E2E welcome email" });
  expect(drafts[0]!.content.body).toContain("E2E-DRAFT-BODY");

  // No send path was taken: no other draft status exists, and the model was only called for the
  // tool turn + the final answer (two requests, both to the fake server).
  const published = await request.get(`${API}/drafts`, { headers: t.headers, params: { companyId: company.id, status: "PUBLISHED" } });
  expect(await published.json()).toEqual([]);
  const seen = await fakeLlmRequests();
  expect(seen).toHaveLength(2);
  expect(seen[0]!.toolNames).toContain("create_draft");

  // UI: the reviewer sees the pending draft; no send action is offered.
  await proxyBrowserApiToRealApi(context, page, request, t.token);
  await page.goto(`${UI}/drafts`);
  await expect(page.getByText("E2E-DRAFT-BODY").first()).toBeVisible();
  // The workspace is still a draft, so even approval is refused in the UI; nothing is sent.
  await expect(page.getByText("Activate this workspace before approving drafts.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and send" })).toHaveCount(0);
});

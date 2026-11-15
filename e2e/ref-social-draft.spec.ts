import { expect, test } from "@playwright/test";
import { API } from "./helpers";
import { UI } from "./ports";
import { fakeLlmRequests, resetFakeLlm } from "./support/fake-llm-client";
import {
  createAgent, createCompany, createPipeline, newPaidTenant, proxyBrowserApiToRealApi, startRun,
  useFakeLlmProvider, waitForRun,
} from "./support/journey";

/**
 * BRA-P0-10b reference journey 6 — social draft.
 * The agent calls the real `social_create_post` tool: it saves a SOCIAL_POST draft on the chosen channel
 * (linkedin), PENDING. No publish path is taken: PUBLISHED stays empty and only the fake model is contacted.
 */
test("social draft: agent saves a PENDING LinkedIn post draft and nothing is published", async ({ request, context, page }) => {
  await resetFakeLlm();
  const t = await newPaidTenant(request);
  await useFakeLlmProvider(request, t);
  const company = await createCompany(request, t);
  await createAgent(request, t, company.id, {
    name: "E2E Social Writer", role: "social_writer",
    systemPrompt: `[e2e:social-draft;companyId=${company.id}] You draft social posts for human review.`,
    tools: ["social_create_post"],
  });
  const pipeline = await createPipeline(request, t, company.id, "social_writer");
  const started = await startRun(request, t, pipeline.id, { brief: "launch post" });

  const run = await waitForRun(request, t, started.id, ["COMPLETED", "FAILED"]);
  expect(run.status, `run error: ${run.error ?? run.steps[0]?.error}`).toBe("COMPLETED");
  const calls = run.steps[0]!.toolCalls;
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((c) => c.toolName === "social_create_post" && c.status === "COMPLETED")).toBe(true);

  const res = await request.get(`${API}/drafts`, { headers: t.headers, params: { companyId: company.id } });
  expect(res.status()).toBe(200);
  const drafts = (await res.json()) as Array<{ type: string; status: string; channel: string | null; content: { body: string; hashtags: string[] } }>;
  expect(drafts).toHaveLength(1);
  expect(drafts[0]).toMatchObject({ type: "SOCIAL_POST", status: "PENDING", channel: "linkedin" });
  expect(drafts[0]!.content.body).toContain("E2E-SOCIAL-BODY");
  expect(drafts[0]!.content.hashtags).toEqual(["e2e", "launch"]);

  // Nothing was published or scheduled for publishing.
  for (const status of ["PUBLISHED", "APPROVED"]) {
    const other = await request.get(`${API}/drafts`, { headers: t.headers, params: { companyId: company.id, status } });
    expect(other.status(), status).toBe(200);
    expect(await other.json(), status).toEqual([]);
  }
  // The model was called only for the tool turn and the final answer, both on the fake server.
  const seen = await fakeLlmRequests();
  expect(seen).toHaveLength(2);
  expect(seen[0]!.toolNames).toContain("social_create_post");
  expect(seen.every((r) => r.path === "/v1/chat/completions")).toBe(true);

  // UI: the reviewer sees the pending post; nothing was sent.
  await proxyBrowserApiToRealApi(context, page, request, t.token);
  await page.goto(`${UI}/drafts`);
  await expect(page.getByText("E2E-SOCIAL-BODY").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and send" })).toHaveCount(0);
});

import { expect, test } from "@playwright/test";
import { API } from "./helpers";
import { UI } from "./ports";
import { fakeLlmRequests, resetFakeLlm } from "./support/fake-llm-client";
import {
  createAgent, createCompany, createPipeline, newPaidTenant, proxyBrowserApiToRealApi, startRun,
  useFakeLlmProvider, waitForRun,
} from "./support/journey";

/**
 * BRA-P0-10 reference journey 1 — chat.
 * The product has no free-form chat endpoint (the Start chat flow is an
 * "unavailable" stub); a conversational turn is a greeting classified as chat
 * plus a tool-less agent run that answers in text. Both are covered with the
 * real API; the model is the fake LLM (no network).
 */
test("chat: greeting is classified as chat and a tool-less agent run returns the fake model's reply", async ({ request, context, page }) => {
  await resetFakeLlm();
  const t = await newPaidTenant(request);

  // Deterministic intent rule (no LLM): a greeting is chat, never a job card.
  const plan = await request.post(`${API}/jobs/plan`, { headers: t.headers, data: { message: "Merhaba" } });
  expect(plan.status()).toBe(200);
  expect(await plan.json()).toEqual({ intent: "chat" });

  await useFakeLlmProvider(request, t);
  const company = await createCompany(request, t);
  await createAgent(request, t, company.id, {
    name: "E2E Chat Assistant", role: "chat_assistant", systemPrompt: "[e2e:chat] You are a friendly assistant.", tools: [],
  });
  const pipeline = await createPipeline(request, t, company.id, "chat_assistant");
  const started = await startRun(request, t, pipeline.id, { message: "Merhaba" });

  const run = await waitForRun(request, t, started.id, ["COMPLETED", "FAILED"]);
  expect(run.status, `run error: ${run.error ?? run.steps[0]?.error}`).toBe("COMPLETED");
  expect(JSON.stringify(run.steps[0]!.output)).toContain("E2E-CHAT-REPLY");
  expect(run.steps[0]!.toolCalls).toHaveLength(0);

  // The model saw exactly one turn, on our own server, and it carried the user's message.
  const seen = await fakeLlmRequests();
  expect(seen).toHaveLength(1);
  expect(seen[0]!.scenario).toBe("chat");
  expect(seen[0]!.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n")).toContain("Merhaba");

  // UI: the user sees the completed run and the model's reasoning excerpt on the run page (browser -> real API).
  await proxyBrowserApiToRealApi(context, page, request, t.token);
  await page.goto(`${UI}/runs/${started.id}`);
  await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("E2E fake model answers the greeting.")).toBeVisible();
});

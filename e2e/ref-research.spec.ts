import { expect, test } from "@playwright/test";
import { API } from "./helpers";
import { fakeLlmRequests, resetFakeLlm } from "./support/fake-llm-client";
import {
  createAgent, createCompany, createPipeline, newPaidTenant, startRun, useFakeLlmProvider, waitForRun,
} from "./support/journey";

/**
 * BRA-P0-10b reference journey 4 — research.
 * Product fact: the only research tool is `web_research_deep`; it starts a background session that needs an
 * external search provider (Tavily/Serper/Brave key) and then fetches pages over the network. `web_search` is a
 * stub that returns no results. E2E configures no search provider (playwright.config blanks the keys), so:
 *  1. a research run with NO web tool produces a sourced summary from the model's own text (no network);
 *  2. the deep-research tool creates a session but can never complete or fetch anything.
 */
test.describe("research stays off the network", () => {
  test("a tool-less research agent returns a sourced summary and calls no tool", async ({ request }) => {
    await resetFakeLlm();
    const t = await newPaidTenant(request);
    await useFakeLlmProvider(request, t);
    const company = await createCompany(request, t);
    await createAgent(request, t, company.id, {
      name: "E2E Researcher", role: "researcher", systemPrompt: "[e2e:research-summary] You summarise research briefs.", tools: [],
    });
    const pipeline = await createPipeline(request, t, company.id, "researcher");
    const started = await startRun(request, t, pipeline.id, { brief: "Compare three planning tools" });

    const run = await waitForRun(request, t, started.id, ["COMPLETED", "FAILED"]);
    expect(run.status, `run error: ${run.error ?? run.steps[0]?.error}`).toBe("COMPLETED");
    const out = JSON.stringify(run.steps[0]!.output);
    expect(out).toContain("E2E-RESEARCH-SUMMARY");
    expect(out).toContain("https://sources.e2e.invalid/alpha");
    expect(run.steps[0]!.toolCalls).toHaveLength(0);

    // The model saw one turn, offered no tools, and was the only peer.
    const seen = await fakeLlmRequests();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.toolNames).toEqual([]);
    expect(seen[0]!.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n")).toContain("Compare three planning tools");
    // No research session was created for this tenant.
    const sessions = await request.get(`${API}/research`, { headers: t.headers });
    expect(await sessions.json()).toEqual([]);
  });

  test("web_research_deep opens a session but, with no search provider, nothing is searched or fetched", async ({ request }) => {
    await resetFakeLlm();
    const t = await newPaidTenant(request);
    await useFakeLlmProvider(request, t);
    const company = await createCompany(request, t);
    await createAgent(request, t, company.id, {
      name: "E2E Deep Researcher", role: "deep_researcher",
      systemPrompt: `[e2e:research-deep;companyId=${company.id}] You research the web.`,
      tools: ["web_research_deep"],
    });
    const pipeline = await createPipeline(request, t, company.id, "deep_researcher");
    const started = await startRun(request, t, pipeline.id, { brief: "market research" });

    const run = await waitForRun(request, t, started.id, ["COMPLETED", "FAILED"]);
    expect(run.status, `run error: ${run.error ?? run.steps[0]?.error}`).toBe("COMPLETED");
    const calls = run.steps[0]!.toolCalls.filter((c) => c.toolName === "web_research_deep");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.status === "COMPLETED")).toBe(true);
    expect(JSON.stringify(run.steps[0]!.output)).toContain("E2E-RESEARCH-STARTED");

    const list = (await (await request.get(`${API}/research`, { headers: t.headers })).json()) as Array<{ id: string; status: string }>;
    expect(list).toHaveLength(1);

    // Observe the session until the background loop has started (RUNNING) or failed; it must never be COMPLETED
    // at any observation, and must never gather sources or findings.
    const observed: string[] = [];
    await expect.poll(async () => {
      const res = await request.get(`${API}/research/${list[0]!.id}`, { headers: t.headers });
      expect(res.status()).toBe(200);
      const session = (await res.json()) as { status: string; sources: unknown[]; findings?: unknown };
      observed.push(session.status);
      expect(session.sources).toEqual([]);
      expect(session.findings == null || (Array.isArray(session.findings) && session.findings.length === 0)).toBe(true);
      return session.status;
    }, { timeout: 15_000, intervals: [250, 500, 1000] }).toMatch(/^(RUNNING|FAILED)$/);
    expect(observed).not.toContain("COMPLETED");

    // Only the fake model was called (tool turn + final answer).
    const seen = await fakeLlmRequests();
    expect(seen).toHaveLength(2); // exactly two: tool turn + final answer, no search/fetch peer
    expect(seen.every((r) => r.path === "/v1/chat/completions")).toBe(true);
  });
});

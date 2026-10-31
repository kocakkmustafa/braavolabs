import { describe, expect, it } from "vitest";
import { orgTree, validateOrg } from "../company";
import { planAgentEffort } from "../effort";
import { AGENT_TEMPLATES, hireFromTemplates, MODEL_TIERS, suggestModel, TEMPLATE_IDS } from "../templates";
import type { AIProviderType } from "../providers";

const keys = (...p: AIProviderType[]) => ({ keys: new Set(p) });

const base = { companyId: "c1", timezone: "Europe/Istanbul" };

describe("starter templates", () => {
  it("are the seven approved agents under one general manager", () => {
    expect(AGENT_TEMPLATES.map(t => t.id)).toEqual([...TEMPLATE_IDS]);
    const plan = hireFromTemplates({ ...base, models: keys("ANTHROPIC", "GROQ") });
    expect(validateOrg(plan.agents)).toEqual([]);
    expect(orgTree(plan.agents)).toEqual([{ id: "ceo", children: [
      { id: "market-analyst", children: [] },
      { id: "content-social", children: [{ id: "customer-voice", children: [] }] },
      { id: "finance-tracker", children: [] },
      { id: "tech-lead", children: [{ id: "release-tracker", children: [] }] },
    ] }]);
  });

  it("never mention the section name and never carry a send or payment capability", () => {
    const text = JSON.stringify(AGENT_TEMPLATES);
    expect(text).not.toMatch(/kadro|şirket|"company"/i);
    for (const t of AGENT_TEMPLATES) {
      for (const tool of t.tools) expect(tool).not.toMatch(/send|post|publish|pay|transfer|email|sms/);
      expect(t.systemPrompt).toContain("never move money");
    }
  });

  it("only name models whose effort maps exactly", () => {
    for (const t of AGENT_TEMPLATES) for (const c of MODEL_TIERS[t.tier]) {
      expect(planAgentEffort(c, t.effort), `${t.id} → ${c.model}`).toMatchObject({ status: "applied", adjusted: false });
    }
  });
});

describe("model suggestion (K3: the user's own keys only)", () => {
  it("suggests only providers the user has a key for, whatever the provider", () => {
    expect(suggestModel("strong", keys("GROQ"))).toEqual({ status: "ok", provider: "GROQ", model: "openai/gpt-oss-120b" });
    expect(suggestModel("strong", keys("CEREBRAS"))).toEqual({ status: "ok", provider: "CEREBRAS", model: "gpt-oss-120b" });
    expect(suggestModel("strong", keys("GROQ", "ANTHROPIC"))).toEqual({ status: "ok", provider: "ANTHROPIC", model: "claude-opus-5-5" });
    expect(suggestModel("light", keys("ANTHROPIC"))).toEqual({ status: "ok", provider: "ANTHROPIC", model: "claude-haiku-5-5" });
  });

  it("puts a pulled local model first for watchers and last for strong work", () => {
    const user = { keys: new Set<AIProviderType>(["ANTHROPIC"]), local: { OLLAMA: ["qwen3:8b"] } };
    expect(suggestModel("light", user)).toEqual({ status: "ok", provider: "OLLAMA", model: "qwen3:8b" });
    expect(suggestModel("strong", user)).toEqual({ status: "ok", provider: "ANTHROPIC", model: "claude-opus-5-5" });
    expect(suggestModel("strong", { keys: new Set(), local: { LMSTUDIO: ["google/gemma-3-4b-it"] } })).toEqual({ status: "ok", provider: "LMSTUDIO", model: "google/gemma-3-4b-it" });
  });

  it("asks for a model or for setup instead of falling back to any company key", () => {
    expect(suggestModel("mid", keys("OPENAI"))).toEqual({ status: "model-required", provider: "OPENAI" });
    expect(suggestModel("mid", keys())).toEqual({ status: "setup-required" });
  });

  it("opens agents without a usable model in error and lists them", () => {
    const none = hireFromTemplates({ ...base, models: keys() });
    expect(none.agents.every(a => a.status === "error")).toBe(true);
    expect(none.needsSetup).toHaveLength(7);
    expect(none.needsSetup[0]).toEqual({ agentId: "ceo", reason: "setup-required" });

    const groqOnly = hireFromTemplates({ ...base, models: keys("GROQ") });
    expect(groqOnly.agents.every(a => a.provider === "GROQ" && a.status === "idle")).toBe(true);
    expect(groqOnly.needsSetup).toEqual([]);

    const openai = hireFromTemplates({ ...base, models: keys("OPENAI") });
    expect(openai.needsSetup.every(n => n.reason === "model-required" && n.provider === "OPENAI")).toBe(true);
  });
});

describe("hiring", () => {
  it("holds watch routines back until URLs are given, then validates them", () => {
    const ag = keys("ANTHROPIC", "GROQ");
    const without = hireFromTemplates({ ...base, models: ag });
    expect(without.needsUrls).toEqual(["market-analyst/watch-competitors", "release-tracker/watch-releases"]);
    expect(without.routines.map(r => r.id)).toEqual(["ceo-weekly-summary", "content-social-weekly-calendar", "customer-voice-daily-feedback", "finance-tracker-daily-finance", "finance-tracker-month-end"]);

    const withUrls = hireFromTemplates({ ...base, models: ag, urls: { "market-analyst/watch-competitors": ["https://rival.example/pricing"] } });
    expect(withUrls.routines.find(r => r.id === "market-analyst-watch-competitors")).toMatchObject({
      preflight: { type: "web", urls: ["https://rival.example/pricing"], notify: ["price", "plans", "promo", "release"] },
      delivery: "silent-unless-change", catchUp: "once", createdBy: "user", timezone: "Europe/Istanbul",
    });
    expect(() => hireFromTemplates({ ...base, models: ag, urls: { "market-analyst/watch-competitors": ["file:///etc/passwd"] } })).toThrow();
  });

  it("hires a subset, localises names and re-roots orphans", () => {
    const plan = hireFromTemplates({ ...base, locale: "tr", templates: ["content-social", "customer-voice", "release-tracker"], models: keys("ANTHROPIC", "GROQ"), makeId: (t, r) => `c1_${t}${r ? `_${r}` : ""}` });
    expect(plan.agents.map(a => [a.id, a.name, a.reportsToAgentId])).toEqual([
      ["c1_content-social", "İçerik ve Sosyal Medya Sorumlusu", null],
      ["c1_customer-voice", "Müşteri Sesi Analisti", "c1_content-social"],
      ["c1_release-tracker", "Sürüm ve Bağımlılık Takipçisi", null],
    ]);
    expect(validateOrg(plan.agents)).toEqual([]);
  });
});

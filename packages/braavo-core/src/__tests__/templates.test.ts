import { describe, expect, it } from "vitest";
import { orgTree, validateOrg } from "../company";
import { planAgentEffort } from "../effort";
import { AGENT_TEMPLATES, hireFromTemplates, MODEL_TIERS, resolveModel, TEMPLATE_IDS } from "../templates";

const base = { companyId: "c1", timezone: "Europe/Istanbul" };

describe("starter templates", () => {
  it("are the seven approved agents under one general manager", () => {
    expect(AGENT_TEMPLATES.map(t => t.id)).toEqual([...TEMPLATE_IDS]);
    const plan = hireFromTemplates({ ...base, availableProviders: new Set(["ANTHROPIC", "GROQ"]) });
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
      if (c === "local") continue;
      expect(planAgentEffort(c, t.effort), `${t.id} → ${c.model}`).toMatchObject({ status: "applied", adjusted: false });
    }
  });
});

describe("model resolution", () => {
  it("prefers a pulled local model, then the keyed provider, and flags a missing key", () => {
    expect(resolveModel("light", new Set(["GROQ"]), "qwen3:8b")).toEqual({ provider: "OLLAMA", model: "qwen3:8b", available: true });
    expect(resolveModel("light", new Set(["GROQ"]))).toEqual({ provider: "GROQ", model: "openai/gpt-oss-20b", available: true });
    expect(resolveModel("strong", new Set(["GROQ"]))).toEqual({ provider: "ANTHROPIC", model: "claude-opus-5-5", available: false });
  });

  it("creates keyless agents in error and reports them", () => {
    const plan = hireFromTemplates({ ...base, availableProviders: new Set(["GROQ"]) });
    const byId = Object.fromEntries(plan.agents.map(a => [a.id, a]));
    expect(byId.ceo).toMatchObject({ provider: "ANTHROPIC", status: "error" });
    expect(byId["market-analyst"]).toMatchObject({ provider: "GROQ", status: "idle", effort: "low" });
    expect(plan.missingKeys.map(m => m.agentId).sort()).toEqual(["ceo", "content-social", "tech-lead"]);
  });
});

describe("hiring", () => {
  it("holds watch routines back until URLs are given, then validates them", () => {
    const keys = new Set(["ANTHROPIC", "GROQ"] as const);
    const without = hireFromTemplates({ ...base, availableProviders: keys });
    expect(without.needsUrls).toEqual(["market-analyst/watch-competitors", "release-tracker/watch-releases"]);
    expect(without.routines.map(r => r.id)).toEqual(["ceo-weekly-summary", "content-social-weekly-calendar", "customer-voice-daily-feedback", "finance-tracker-daily-finance", "finance-tracker-month-end"]);

    const withUrls = hireFromTemplates({ ...base, availableProviders: keys, urls: { "market-analyst/watch-competitors": ["https://rival.example/pricing"] } });
    expect(withUrls.routines.find(r => r.id === "market-analyst-watch-competitors")).toMatchObject({
      preflight: { type: "web", urls: ["https://rival.example/pricing"], notify: ["price", "plans", "promo", "release"] },
      delivery: "silent-unless-change", catchUp: "once", createdBy: "user", timezone: "Europe/Istanbul",
    });
    expect(() => hireFromTemplates({ ...base, availableProviders: keys, urls: { "market-analyst/watch-competitors": ["file:///etc/passwd"] } })).toThrow();
  });

  it("hires a subset, localises names and re-roots orphans", () => {
    const plan = hireFromTemplates({ ...base, locale: "tr", templates: ["content-social", "customer-voice", "release-tracker"], availableProviders: new Set(["ANTHROPIC", "GROQ"]), makeId: (t, r) => `c1_${t}${r ? `_${r}` : ""}` });
    expect(plan.agents.map(a => [a.id, a.name, a.reportsToAgentId])).toEqual([
      ["c1_content-social", "İçerik ve Sosyal Medya Sorumlusu", null],
      ["c1_customer-voice", "Müşteri Sesi Analisti", "c1_content-social"],
      ["c1_release-tracker", "Sürüm ve Bağımlılık Takipçisi", null],
    ]);
    expect(validateOrg(plan.agents)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { AgentSpecSchema, canCreateRoutine, canDelegate, orgTree, RoutineSpecSchema, validateOrg } from "../company";

const a = (id: string, reportsToAgentId: string | null, companyId = "c1") => ({ id, companyId, reportsToAgentId });

describe("agent spec", () => {
  it("applies defaults and accepts the org fields", () => {
    const spec = AgentSpecSchema.parse({ id: "ceo", companyId: "c1", name: "CEO", role: "ceo", systemPrompt: "Lead.", provider: "ANTHROPIC", model: "claude-opus-5-5", effort: "medium" });
    expect(spec).toMatchObject({ reportsToAgentId: null, status: "idle", autonomy: "BALANCED", effortRounding: "down", engine: "native", tools: [] });
  });

  it("rejects unknown providers, efforts, engines and negative budgets", () => {
    const base = { id: "x", companyId: "c1", name: "X", role: "r", systemPrompt: "", provider: "GROQ", model: "m" };
    expect(AgentSpecSchema.safeParse({ ...base, provider: "NOPE" }).success).toBe(false);
    expect(AgentSpecSchema.safeParse({ ...base, effort: "xhigh" }).success).toBe(false);
    expect(AgentSpecSchema.safeParse({ ...base, engine: "acp:Claude Code" }).success).toBe(false);
    expect(AgentSpecSchema.safeParse({ ...base, engine: "acp:claude-code" }).success).toBe(true);
    expect(AgentSpecSchema.safeParse({ ...base, budgetUsdMonthly: -1 }).success).toBe(false);
  });
});

describe("org chart", () => {
  const org = [a("ceo", null), a("cmo", "ceo"), a("analyst", "cmo"), a("cto", "ceo"), a("coder", "cto")];

  it("accepts a valid tree and builds it", () => {
    expect(validateOrg(org)).toEqual([]);
    expect(orgTree(org)).toEqual([{ id: "ceo", children: [
      { id: "cmo", children: [{ id: "analyst", children: [] }] },
      { id: "cto", children: [{ id: "coder", children: [] }] },
    ] }]);
  });

  it("reports self-reports, unknown managers, cross-company managers and cycles once", () => {
    expect(validateOrg([a("x", "x")])).toEqual([{ kind: "self-report", agentId: "x" }]);
    expect(validateOrg([a("x", "ghost")])).toEqual([{ kind: "unknown-manager", agentId: "x", managerId: "ghost" }]);
    expect(validateOrg([a("boss", null, "c2"), a("x", "boss", "c1")])).toEqual([{ kind: "cross-company", agentId: "x", managerId: "boss" }]);
    expect(validateOrg([a("p", "q"), a("q", "r"), a("r", "p"), a("s", "p")])).toEqual([{ kind: "cycle", agentIds: ["p", "q", "r"] }]);
  });

  it("lets delegation flow only down the reporting line", () => {
    expect(canDelegate(org, "ceo", "analyst")).toBe(true);
    expect(canDelegate(org, "cmo", "analyst")).toBe(true);
    expect(canDelegate(org, "cmo", "coder")).toBe(false);
    expect(canDelegate(org, "analyst", "ceo")).toBe(false);
    expect(canDelegate(org, "ceo", "ceo")).toBe(false);
    expect(canDelegate([a("p", "q"), a("q", "p")], "z", "p")).toBe(false);
  });
});

describe("routine spec", () => {
  const base = { id: "r1", companyId: "c1", agentId: "analyst", name: "Watch rivals", prompt: "Summarize changes.", rrule: "FREQ=HOURLY;INTERVAL=6", timezone: "Europe/Istanbul", createdBy: "user" };

  it("applies safe defaults", () => {
    expect(RoutineSpecSchema.parse(base)).toMatchObject({ enabled: true, preflight: { type: "none" }, delivery: "inbox", catchUp: "once", concurrency: "skip-if-running", maxRunsPerDay: 24 });
  });

  it("validates rrule, time zone, preflight URLs and creator", () => {
    expect(RoutineSpecSchema.safeParse({ ...base, rrule: "every 6 hours" }).success).toBe(false);
    expect(RoutineSpecSchema.safeParse({ ...base, timezone: "Mars/Olympus" }).success).toBe(false);
    expect(RoutineSpecSchema.safeParse({ ...base, preflight: { type: "web", urls: ["file:///etc/passwd"], notify: ["price"] } }).success).toBe(false);
    expect(RoutineSpecSchema.safeParse({ ...base, preflight: { type: "web", urls: ["https://rival.example/pricing"], notify: ["price", "promo"] }, delivery: "silent-unless-change" }).success).toBe(true);
    expect(RoutineSpecSchema.safeParse({ ...base, createdBy: "agent:analyst" }).success).toBe(true);
    expect(RoutineSpecSchema.safeParse({ ...base, createdBy: "someone" }).success).toBe(false);
  });

  it("forbids routines from creating routines", () => {
    expect(canCreateRoutine({ origin: "routine" })).toBe(false);
    expect(canCreateRoutine({ origin: "chat" })).toBe(true);
  });
});

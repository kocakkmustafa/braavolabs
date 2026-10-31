/** Pure planner: no transport, no keys. Exact-profile rule mirrors reasoning-effort.ts. */
import { describe, expect, it } from "vitest";
import { AGENT_EFFORTS, AGENT_EFFORT_PROFILES, agentEffortsFor, planAgentEffort } from "../agent-effort";
import { REASONING_EFFORT_CAPABILITIES, supportedReasoningEfforts } from "../reasoning-effort";

describe("per-agent effort planning", () => {
  it("maps Anthropic efforts to output_config.effort on the first-party endpoint", () => {
    for (const effort of ["low", "medium", "high", "max"] as const) {
      expect(planAgentEffort({ provider: "ANTHROPIC", model: "claude-opus-5-5" }, effort)).toEqual({
        status: "applied", requested: effort, providerEffort: effort, wire: { output_config: { effort } }, adjusted: false, rounding: "down",
      });
    }
  });

  it("degrades none to the weakest level on models that cannot stop reasoning", () => {
    expect(planAgentEffort({ provider: "ANTHROPIC", model: "claude-opus-5-5" }, "none")).toMatchObject({
      status: "applied", providerEffort: "low", wire: { output_config: { effort: "low" } }, adjusted: true,
    });
    expect(planAgentEffort({ provider: "GROQ", model: "openai/gpt-oss-120b" }, "none")).toMatchObject({ providerEffort: "low", adjusted: true });
  });

  it("passes none through where the model documents it", () => {
    expect(planAgentEffort({ provider: "GROQ", model: "qwen/qwen3.8-27b" }, "none")).toEqual({
      status: "applied", requested: "none", providerEffort: "none", wire: { reasoning_effort: "none" }, adjusted: false, rounding: "down",
    });
  });

  it("never spends more than asked: max maps down to the strongest level below it", () => {
    expect(planAgentEffort({ provider: "GROQ", model: "openai/gpt-oss-20b" }, "max")).toMatchObject({ providerEffort: "high", wire: { reasoning_effort: "high" }, adjusted: true });
    expect(planAgentEffort({ provider: "GROQ", model: "meta-models/muse-spark-open" }, "max")).toMatchObject({ providerEffort: "xhigh", adjusted: true });
    expect(planAgentEffort({ provider: "ANTHROPIC", model: "claude-opus-4-6" }, "max")).toMatchObject({ providerEffort: "max", adjusted: false });
  });

  it("rounds up per agent when asked, and down by default", () => {
    const oss = { provider: "GROQ" as const, model: "openai/gpt-oss-120b" };
    const muse = { provider: "GROQ" as const, model: "meta-models/muse-spark-open" };
    expect(planAgentEffort(oss, "max")).toMatchObject({ providerEffort: "high", rounding: "down" });
    // Nothing stronger than high on gpt-oss: "up" falls back to the strongest available.
    expect(planAgentEffort(oss, "max", { rounding: "up" })).toMatchObject({ providerEffort: "high", adjusted: true, rounding: "up" });
    expect(planAgentEffort(muse, "max", { rounding: "up" })).toMatchObject({ providerEffort: "xhigh", adjusted: true });
    // "none" can only move up, whatever the rounding.
    expect(planAgentEffort(oss, "none", { rounding: "down" })).toMatchObject({ providerEffort: "low" });
    expect(planAgentEffort(oss, "none", { rounding: "up" })).toMatchObject({ providerEffort: "low" });
    // Exact matches ignore rounding.
    expect(planAgentEffort(oss, "medium", { rounding: "up" })).toMatchObject({ providerEffort: "medium", adjusted: false });
    expect(planAgentEffort(oss, "high", { rounding: "sideways" })).toMatchObject({ status: "unsupported", reason: "unknown-rounding" });
  });

  it("refuses unprofiled models, look-alike names and other providers instead of guessing", () => {
    for (const config of [
      { provider: "ANTHROPIC" as const, model: "claude-haiku-4-5" },
      { provider: "ANTHROPIC" as const, model: "claude-opus-5-5-20260401" },
      { provider: "OPENAI" as const, model: "gpt-6.1-sol" },
      { provider: "GOOGLE" as const, model: "gemini-4-argon" },
      { provider: "OPENROUTER" as const, model: "openai/gpt-oss-120b" },
    ]) {
      expect(planAgentEffort(config, "high"), `${config.provider}/${config.model}`).toEqual({ status: "unsupported", requested: "high", reason: "no-profile" });
    }
  });

  it("refuses proxies and custom endpoints, but accepts the built-in URL with a trailing slash", () => {
    expect(planAgentEffort({ provider: "GROQ", model: "openai/gpt-oss-120b", baseUrl: "https://proxy.example/v1" }, "low"))
      .toEqual({ status: "unsupported", requested: "low", reason: "endpoint-mismatch" });
    expect(planAgentEffort({ provider: "GROQ", model: "openai/gpt-oss-120b", baseUrl: " https://api.groq.com/openai/v1/ " }, "low"))
      .toMatchObject({ status: "applied", providerEffort: "low" });
  });

  it("rejects unknown effort values", () => {
    for (const bad of ["xhigh", "HIGH", "", undefined, 3]) {
      expect(planAgentEffort({ provider: "ANTHROPIC", model: "claude-opus-5-5" }, bad)).toMatchObject({ status: "unsupported", reason: "unknown-effort" });
    }
  });

  it("agrees with the live Cerebras capability check", () => {
    const cerebras = REASONING_EFFORT_CAPABILITIES[0];
    const config = { provider: cerebras.provider as "CEREBRAS", model: cerebras.model };
    expect(agentEffortsFor(config)).toEqual(supportedReasoningEfforts({ ...config, apiKey: "synthetic" } as any));
    expect(planAgentEffort(config, "medium")).toMatchObject({ wire: { reasoning_effort: "medium" }, adjusted: false });
  });

  it("offers pickers only exact, unadjusted levels", () => {
    expect(agentEffortsFor({ provider: "ANTHROPIC", model: "claude-opus-5-5" })).toEqual(["low", "medium", "high", "max"]);
    expect(agentEffortsFor({ provider: "GROQ", model: "qwen/qwen3.8-27b" })).toEqual(["none", "low", "medium", "high"]);
    expect(agentEffortsFor({ provider: "OPENAI", model: "gpt-6.1-sol" })).toEqual([]);
  });

  it("keeps profiles exact and non-overlapping", () => {
    const seen = new Set<string>();
    for (const profile of AGENT_EFFORT_PROFILES) {
      for (const model of profile.models) {
        const key = `${profile.provider}/${model}`;
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
        expect(model).not.toMatch(/[*?]/);
      }
      expect(profile.efforts.length).toBeGreaterThan(0);
    }
    expect(AGENT_EFFORTS).toEqual(["none", "low", "medium", "high", "max"]);
  });
});

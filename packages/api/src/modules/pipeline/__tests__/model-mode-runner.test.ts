/**
 * BRA-P0-06a-2 dilim 3 — runStepWithModelMode: DIRECT/CASCADE/COMPARE (sahte runLoop; ağ/LLM yok).
 */
import { describe, it, expect, vi } from "vitest";
import { runStepWithModelMode, deriveCheapModel, type RunLoopFn } from "../model-mode-runner";

const GOOD = "Bu yanıt yeterince uzun, tamamlanmış ve güvenli görünen bir cevaptır; ayrıntılı açıklama içerir ve reddetme belirtisi taşımaz.";
const BAD = "I cannot answer that, insufficient information.";

function res(over: Record<string, unknown> = {}) {
  return {
    finalContent: GOOD,
    turns: [{ content: GOOD, toolCalls: [], inputTokens: 10, outputTokens: 5, costUsd: 0.01, stopReason: "end_turn" }],
    totalInputTokens: 10, totalOutputTokens: 5, totalCostUsd: 0.01, totalToolCalls: 0,
    provider: "ANTHROPIC", ...over,
  } as any;
}
const params = { systemPrompt: "s", userMessage: "u", toolNames: ["t1"], budgetUsd: 1 } as any;
const mk = (fn: (p: any) => any): RunLoopFn & ReturnType<typeof vi.fn> => vi.fn(async (p: any) => fn(p)) as any;
const STRONG = "claude-sonnet-5-5";

describe("DIRECT", () => {
  it("tek runLoop, agent.model ile", async () => {
    const run = mk((p) => res({ model: p.model }));
    const r = await runStepWithModelMode({ agent: { model: STRONG, tools: ["t1"] }, companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 1 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].model).toBe(STRONG);
    expect(r.modelMode).toBe("DIRECT");
    expect(r.modeDetail).toMatchObject({ requested: "DIRECT", effective: "DIRECT", source: "default" });
  });
  it("takeover DIRECT'e zorlar", async () => {
    const run = mk(() => res());
    const r = await runStepWithModelMode({ agent: { model: STRONG, tools: [], modelMode: "COMPARE" }, companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 1, forceDirectReason: "takeover" });
    expect(r.modelMode).toBe("DIRECT");
    expect(r.modeDetail).toMatchObject({ requested: "COMPARE", fallback: "takeover" });
  });
});

describe("deriveCheapModel", () => {
  it("aynı sağlayıcıdan kesin daha ucuz model", () => {
    expect(deriveCheapModel(STRONG)).toBe("claude-haiku-5-5");
  });
  it("bilinmeyen model / boş -> null", () => {
    expect(deriveCheapModel("bilinmeyen-x")).toBeNull();
    expect(deriveCheapModel(null)).toBeNull();
  });
});

describe("CASCADE", () => {
  const agent = (extra: Record<string, unknown> = {}) => ({ model: STRONG, tools: ["t1"], modelMode: "CASCADE", ...extra });
  it("güven yüksek -> yükseltme yok", async () => {
    const run = mk(() => res({ model: "claude-haiku-5-5" }));
    const r = await runStepWithModelMode({ agent: agent(), companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 1 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].model).toBe("claude-haiku-5-5");
    expect(r.modeDetail).toMatchObject({ escalated: false, escalation: "not_needed", effective: "CASCADE" });
  });
  it("güven düşük -> yükseltir, maliyetler toplanır", async () => {
    const run = mk((p) => p.model === STRONG
      ? res({ model: STRONG, totalCostUsd: 0.05, totalInputTokens: 100, totalOutputTokens: 50 })
      : res({ model: "claude-haiku-5-5", finalContent: BAD, totalCostUsd: 0.01 }));
    const r = await runStepWithModelMode({ agent: agent(), companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 1 });
    expect(run).toHaveBeenCalledTimes(2);
    expect(r.result.model).toBe(STRONG);
    expect(r.result.finalContent).toBe(GOOD);
    expect(r.result.totalCostUsd).toBeCloseTo(0.06);
    expect(r.result.totalInputTokens).toBe(110);
    expect(r.result.totalOutputTokens).toBe(55);
    expect(r.modeDetail).toMatchObject({ escalated: true, escalation: "low_confidence" });
  });
  it("araç kullanıldı -> yükseltme yok", async () => {
    const withTool = res({ finalContent: BAD, totalToolCalls: 1, turns: [{ content: "", toolCalls: [{ id: "1", name: "t1", input: {}, output: {}, durationMs: 1 }], inputTokens: 1, outputTokens: 1, costUsd: 0, stopReason: "end_turn" }] });
    const run = mk(() => withTool);
    const r = await runStepWithModelMode({ agent: agent(), companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 1 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(r.modeDetail).toMatchObject({ escalated: false, escalation: "skipped_tools_used" });
  });
  it("ucuz model bulunamadı -> DIRECT + fallback", async () => {
    const run = mk(() => res());
    const r = await runStepWithModelMode({ agent: agent({ model: "bilinmeyen-x" }), companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 1 });
    expect(r.modelMode).toBe("DIRECT");
    expect(r.modeDetail).toMatchObject({ requested: "CASCADE", fallback: "no_cheap_model" });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("config.cheapModel ve eşik kullanılır", async () => {
    const run = mk(() => res());
    await runStepWithModelMode({ agent: agent({ modelModeConfig: { cheapModel: "my-cheap", confidenceThreshold: 0.1 } }), companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 1 });
    expect(run.mock.calls[0][0].model).toBe("my-cheap");
  });
  it("budgetUsdCap aşıldı -> yükseltme yok", async () => {
    const run = mk(() => res({ finalContent: BAD, totalCostUsd: 0.5 }));
    const r = await runStepWithModelMode({ agent: agent({ modelModeConfig: { budgetUsdCap: 0.5 } }), companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 10 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(r.modeDetail).toMatchObject({ escalation: "skipped_budget_cap" });
  });
  it("kalan bütçe yetersiz -> yükseltme yok", async () => {
    const run = mk(() => res({ finalContent: BAD, totalCostUsd: 0.6 }));
    const r = await runStepWithModelMode({ agent: agent(), companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 0.5 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(r.modeDetail).toMatchObject({ escalation: "skipped_budget" });
  });
  it("şirket kipi ve autoSelection CASCADE'i seçer", async () => {
    const run = mk(() => res());
    const r = await runStepWithModelMode({ agent: { model: STRONG, tools: [] }, companyConfig: { autoSelection: { enabled: true } }, loopParams: params, runLoop: run, runBudgetUsd: 1 });
    expect(r.modelMode).toBe("CASCADE");
    expect(r.modeDetail).toMatchObject({ source: "auto" });
  });
  it("throw yayılır, yükseltme yok", async () => {
    const run = mk(() => { throw new Error("boom"); });
    await expect(runStepWithModelMode({ agent: agent(), companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 1 })).rejects.toThrow("boom");
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("COMPARE", () => {
  const cfg = { compareModels: ["m-a", "m-b", "m-c"] };
  const agent = (extra: Record<string, unknown> = {}) => ({ model: STRONG, tools: [], modelMode: "COMPARE", modelModeConfig: cfg, ...extra });
  it("3 aday ardışık, toolNames [] ve extraTools yok; en yüksek güven seçilir", async () => {
    const order: string[] = [];
    const run = mk((p) => {
      order.push(p.model);
      return res({ model: p.model, finalContent: p.model === "m-b" ? GOOD : BAD, totalCostUsd: 0.1 });
    });
    const r = await runStepWithModelMode({ agent: agent(), companyConfig: {}, loopParams: { ...params, extraTools: new Map() }, runLoop: run, runBudgetUsd: 5 });
    expect(order).toEqual(["m-a", "m-b", "m-c"]);
    for (const c of run.mock.calls) {
      expect(c[0].toolNames).toEqual([]);
      expect("extraTools" in c[0]).toBe(false);
    }
    expect(r.modelMode).toBe("COMPARE");
    expect(r.result.model).toBe("m-b");
    expect(r.result.totalCostUsd).toBeCloseTo(0.3);
    const cands = r.modeDetail.candidates as any[];
    expect(cands.map((c) => c.selected)).toEqual([false, true, false]);
    expect(cands[0]).toMatchObject({ model: "m-a", costUsd: 0.1 });
  });
  it("eşitlikte listedeki ilk", async () => {
    const run = mk((p) => res({ model: p.model }));
    const r = await runStepWithModelMode({ agent: agent(), companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 5 });
    expect(r.result.model).toBe("m-a");
  });
  it("araçlı ajan -> DIRECT fallback", async () => {
    const run = mk(() => res());
    const r = await runStepWithModelMode({ agent: agent({ tools: ["t1"] }), companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 5 });
    expect(r.modelMode).toBe("DIRECT");
    expect(r.modeDetail).toMatchObject({ fallback: "compare_requires_toolless_agent" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].toolNames).toEqual(["t1"]);
  });
  it("<2 aday -> fallback", async () => {
    const run = mk(() => res());
    const r = await runStepWithModelMode({ agent: agent({ modelModeConfig: { compareModels: ["m-a"] } }), companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 5 });
    expect(r.modeDetail).toMatchObject({ fallback: "compare_needs_2_3_models" });
    expect(r.modelMode).toBe("DIRECT");
  });
  it("bütçe aşımı -> kalan adaylar atlanır", async () => {
    const run = mk((p) => res({ model: p.model, totalCostUsd: 0.6 }));
    const r = await runStepWithModelMode({ agent: agent({ modelModeConfig: { ...cfg, budgetUsdCap: 0.5 } }), companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 5 });
    expect(run).toHaveBeenCalledTimes(1);
    const cands = r.modeDetail.candidates as any[];
    expect(cands.map((c) => c.skipped)).toEqual([undefined, "budget_cap", "budget_cap"]);
    expect(r.result.model).toBe("m-a");
    expect(cands[0].selected).toBe(true);
  });
  it("throw yayılır", async () => {
    const run = mk(() => { throw new Error("boom"); });
    await expect(runStepWithModelMode({ agent: agent(), companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 5 })).rejects.toThrow("boom");
  });
});

describe("bütçe sınırı: budgetUsd = min(kalan, cap - harcanan)", () => {
  it("CASCADE güçlü koşu min() bütçesiyle çağrılır", async () => {
    const run = mk((p) => p.model === STRONG ? res({ model: STRONG }) : res({ model: "claude-haiku-5-5", finalContent: BAD, totalCostUsd: 0.2 }));
    await runStepWithModelMode({ agent: { model: STRONG, tools: [], modelMode: "CASCADE", modelModeConfig: { budgetUsdCap: 0.5 } }, companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 1 });
    // min(1 - 0.2, 0.5 - 0.2) = 0.3
    expect(run.mock.calls[1][0].budgetUsd).toBeCloseTo(0.3);
  });
  it("CASCADE cap yok: kalan koşu bütçesi", async () => {
    const run = mk((p) => p.model === STRONG ? res({ model: STRONG }) : res({ model: "claude-haiku-5-5", finalContent: BAD, totalCostUsd: 0.2 }));
    await runStepWithModelMode({ agent: { model: STRONG, tools: [], modelMode: "CASCADE" }, companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 1 });
    expect(run.mock.calls[1][0].budgetUsd).toBeCloseTo(0.8);
  });
  it("tek tur bütçeyi aştı (maliyet > bütçe) -> CASCADE yükseltmez, skipped_budget", async () => {
    const run = mk(() => res({ model: "claude-haiku-5-5", finalContent: BAD, totalCostUsd: 2 }));
    const r = await runStepWithModelMode({ agent: { model: STRONG, tools: [], modelMode: "CASCADE" }, companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 1 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(r.modeDetail).toMatchObject({ escalation: "skipped_budget" });
  });
  it("COMPARE: sonraki aday min() ile çağrılır; <=0 ise atlanır (budget)", async () => {
    const run = mk((p) => res({ model: p.model, totalCostUsd: 0.6 }));
    const r = await runStepWithModelMode({ agent: { model: STRONG, tools: [], modelMode: "COMPARE", modelModeConfig: { compareModels: ["m-a", "m-b", "m-c"], budgetUsdCap: 0.9 } }, companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 1 });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0].budgetUsd).toBeCloseTo(0.3); // min(0.4, 0.3)
    expect((r.modeDetail.candidates as any[]).map((c) => c.skipped)).toEqual([undefined, undefined, "budget_cap"]);
  });
  it("COMPARE: koşu bütçesi tükendi -> skipped budget", async () => {
    const run = mk((p) => res({ model: p.model, totalCostUsd: 2 }));
    const r = await runStepWithModelMode({ agent: { model: STRONG, tools: [], modelMode: "COMPARE", modelModeConfig: { compareModels: ["m-a", "m-b"] } }, companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 1 });
    expect(run).toHaveBeenCalledTimes(1);
    expect((r.modeDetail.candidates as any[])[1].skipped).toBe("budget");
  });
});

describe("sağlayıcı uyumsuzluğu", () => {
  it("CASCADE: ucuz deneme farklı modelde koştu -> yükseltme yok", async () => {
    const run = mk(() => res({ model: "baska-model", provider: "OLLAMA", finalContent: BAD }));
    const r = await runStepWithModelMode({ agent: { model: STRONG, tools: [], modelMode: "CASCADE" }, companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 1 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(r.modeDetail).toMatchObject({ escalation: "skipped_provider_mismatch" });
    expect((r.modeDetail.attempts as any[])[0]).toMatchObject({ model: "claude-haiku-5-5", actualModel: "baska-model", actualProvider: "OLLAMA" });
  });
  it("CASCADE yükseltmede attempts[] gerçek model/sağlayıcıyı taşır", async () => {
    const run = mk((p) => p.model === STRONG ? res({ model: STRONG }) : res({ model: "claude-haiku-5-5", finalContent: BAD }));
    const r = await runStepWithModelMode({ agent: { model: STRONG, tools: [], modelMode: "CASCADE" }, companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 1 });
    const att = r.modeDetail.attempts as any[];
    expect(att.map((a) => a.actualModel)).toEqual(["claude-haiku-5-5", STRONG]);
    expect(att[1].actualProvider).toBe("ANTHROPIC");
  });
  it("COMPARE: hepsi aynı actualModel -> uyarı, seçim yine yapılır", async () => {
    const run = mk(() => res({ model: "ayni" }));
    const r = await runStepWithModelMode({ agent: { model: STRONG, tools: [], modelMode: "COMPARE", modelModeConfig: { compareModels: ["m-a", "m-b"] } }, companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 5 });
    expect(r.modeDetail.warning).toBe("candidates_resolved_to_same_model");
    expect((r.modeDetail.candidates as any[]).filter((c) => c.selected)).toHaveLength(1);
    expect((r.modeDetail.candidates as any[])[0]).toMatchObject({ actualModel: "ayni", actualProvider: "ANTHROPIC" });
  });
  it("COMPARE: farklı modeller -> uyarı yok; uzun ad 200'e kırpılır", async () => {
    const long = "x".repeat(300);
    const run = mk((p) => res({ model: p.model === "m-a" ? long : "b" }));
    const r = await runStepWithModelMode({ agent: { model: STRONG, tools: [], modelMode: "COMPARE", modelModeConfig: { compareModels: ["m-a", "m-b"] } }, companyConfig: {}, loopParams: params, runLoop: run, runBudgetUsd: 5 });
    expect("warning" in r.modeDetail).toBe(false);
    expect((r.modeDetail.candidates as any[])[0].actualModel).toHaveLength(200);
  });
});

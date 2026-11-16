/**
 * BRA-P0-06a-2 dilim 3 — model kiplerinin (DIRECT/CASCADE/COMPARE) pipeline ajan adımı
 * çalışma zamanı davranışı.
 *
 *  - DIRECT  = seçilen tek model (bugünkü davranış).
 *  - CASCADE = ucuz modelle başla; güven düşükse VE yan etki yoksa güçlü modele (agent.model) geç.
 *  - COMPARE = 2–3 model aynı işi ardışık yapar; en yüksek güvenli sonuç seçilir.
 *
 * Güvenlik gerekçesi (CLAUDE.md kural #3 — para/yan etki): araç çağrısı yapılmış bir deneme
 * tekrarlanamaz. CASCADE araç kullanıldıysa yükseltmez; COMPARE yalnız araçsız ajanda çalışır.
 *
 * `runLoop` enjekte edilir (üretimde runAgentLoop; testte sahte). modeDetail küçük ve JSON-güvenlidir:
 * yalnız model adları, sayılar, nedenler (prompt/istek içeriği/sır YOK).
 */
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  isCompareConfigValid,
  normalizeModelModeConfig,
  resolveEffectiveModelMode,
  type ModelMode,
  type ModelModeConfig,
} from "@ai-company-os/core";
import type { AgentLoopResult, runAgentLoop } from "../agent/claude";
import { computeHeuristicConfidence } from "../research/cascade.service";
import { parseAutoSelectionEnabled, parseCompanyModelMode } from "../company/model-mode-settings";
import { PROVIDER_MODELS, LOCAL_PROVIDERS, isModelCompatibleWithProvider, type AIProviderType } from "../../services/ai-client";
import { deriveTier } from "../../lib/routing";
import { priceForModel } from "../../lib/modelPricing";

type LoopParams = Parameters<typeof runAgentLoop>[0];
export type ModeLoopParams = Omit<LoopParams, "model">;
export type RunLoopFn = (params: LoopParams) => Promise<AgentLoopResult>;

export interface ModeRunnerAgent {
  model: string | null | undefined;
  tools: unknown;
  modelMode?: unknown;
  modelModeConfig?: unknown;
}

export interface RunStepWithModelModeOptions {
  agent: ModeRunnerAgent;
  /** Company.config (ham Json). */
  companyConfig: unknown;
  loopParams: ModeLoopParams;
  runLoop: RunLoopFn;
  /**
   * Koşunun TOPLAM bütçesi (USD) — adımın harcamalarıyla azalan "kalan" değil; denemelere verilen
   * budgetUsd = min(runBudgetUsd - harcanan, budgetUsdCap - harcanan) bu değerden türetilir.
   */
  runBudgetUsd: number;
  /** true ise kip DIRECT'e zorlanır (takeover: aiConfigOverride/resumeMessages). */
  forceDirectReason?: string;
}

export interface ModelModeRunResult {
  result: AgentLoopResult;
  /** Fiilen uygulanan kip. */
  modelMode: ModelMode;
  modeDetail: Record<string, unknown>;
}

/** modeDetail model adı alanları: ≤200 karakter, string değilse null. */
function clip(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, 200) : null;
}

function usedTools(r: AgentLoopResult): boolean {
  return (r.totalToolCalls ?? 0) > 0 || r.turns.some((t) => t.toolCalls.length > 0);
}

function confidenceOf(r: AgentLoopResult): number {
  return computeHeuristicConfidence(r.finalContent ?? "", r.turns[r.turns.length - 1]?.stopReason);
}

function blended(model: string): number | null {
  const p = priceForModel(model);
  return p ? p.inputPerM + p.outputPerM * 3 : null;
}

/**
 * Ucuz model türetme: agent.model'in sağlayıcı kataloğundan, ondan KESİN daha ucuz,
 * fiyatı bilinen, tier "cheap"/"local" olan en ucuz model. Bulunamazsa null.
 */
export function deriveCheapModel(strongModel: string | null | undefined): string | null {
  if (!strongModel) return null;
  const strongPrice = blended(strongModel);
  if (strongPrice === null) return null;
  const provider = (Object.keys(PROVIDER_MODELS) as AIProviderType[]).find(
    (p) => !LOCAL_PROVIDERS.has(p) && isModelCompatibleWithProvider(p, strongModel),
  );
  if (!provider) return null;
  let best: { model: string; price: number } | null = null;
  for (const m of PROVIDER_MODELS[provider]) {
    const price = blended(m);
    if (price === null || price >= strongPrice) continue;
    const tier = deriveTier(m);
    if (tier !== "cheap" && tier !== "local") continue;
    if (!best || price < best.price) best = { model: m, price };
  }
  return best?.model ?? null;
}

export async function runStepWithModelMode(opts: RunStepWithModelModeOptions): Promise<ModelModeRunResult> {
  const { agent, loopParams, runLoop, runBudgetUsd } = opts;
  const config = normalizeModelModeConfig(agent.modelModeConfig);
  const effective = resolveEffectiveModelMode({
    agentMode: agent.modelMode,
    companyMode: parseCompanyModelMode(opts.companyConfig),
    autoSelectionEnabled: parseAutoSelectionEnabled(opts.companyConfig),
  });
  const base = { requested: effective.mode, source: effective.source };
  const strongModel = agent.model ?? undefined;

  const direct = async (extra: Record<string, unknown>): Promise<ModelModeRunResult> => {
    const result = await runLoop({ ...loopParams, model: strongModel });
    return { result, modelMode: "DIRECT", modeDetail: { ...base, effective: "DIRECT", ...extra } };
  };

  if (opts.forceDirectReason) return direct({ fallback: opts.forceDirectReason });
  if (effective.mode === "DIRECT") return direct({});

  if (effective.mode === "CASCADE") return runCascade();
  return runCompare();

  /** Sonraki denemeye verilebilecek bütçe: min(koşu kalanı, cap - harcanan). <=0 ise deneme atlanır. */
  function allowance(spent: number): { usd: number; reason?: "budget" | "budget_cap" } {
    const remaining = runBudgetUsd - spent;
    const capLeft = config.budgetUsdCap !== undefined ? config.budgetUsdCap - spent : Infinity;
    if (capLeft <= 0) return { usd: capLeft, reason: "budget_cap" };
    if (remaining <= 0) return { usd: remaining, reason: "budget" };
    return { usd: Math.min(remaining, capLeft) };
  }

  async function runCascade(): Promise<ModelModeRunResult> {
    const cheapModel = config.cheapModel ?? deriveCheapModel(agent.model);
    if (!cheapModel) return direct({ fallback: "no_cheap_model" });
    const threshold = config.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    const cheap = await runLoop({ ...loopParams, model: cheapModel });
    const confidence = confidenceOf(cheap);
    const cheapAttempt = {
      role: "cheap",
      model: clip(cheapModel),
      actualModel: clip(cheap.model),
      actualProvider: clip(cheap.provider),
      costUsd: cheap.totalCostUsd,
      confidence,
    };
    const detail: Record<string, unknown> = {
      ...base,
      effective: "CASCADE",
      cheapModel: clip(cheapModel),
      cheapModelDerived: !config.cheapModel,
      strongModel: clip(strongModel),
      threshold,
      confidence,
      cheapCostUsd: cheap.totalCostUsd,
    };
    const stay = (escalation: string): ModelModeRunResult => ({
      result: cheap,
      modelMode: "CASCADE",
      modeDetail: { ...detail, escalated: false, escalation, attempts: [cheapAttempt] },
    });

    if (confidence >= threshold) return stay("not_needed");
    if (usedTools(cheap)) return stay("skipped_tools_used");
    // Sağlayıcı istenen ucuz modeli sessizce başka modele çevirdiyse ucuz/güçlü ayrımı anlamsız.
    if (cheap.model && cheap.model !== cheapModel) return stay("skipped_provider_mismatch");
    const allow = allowance(cheap.totalCostUsd);
    if (allow.reason) return stay(allow.reason === "budget_cap" ? "skipped_budget_cap" : "skipped_budget");

    const strong = await runLoop({ ...loopParams, model: strongModel, budgetUsd: allow.usd });
    const merged: AgentLoopResult = {
      ...strong,
      totalCostUsd: cheap.totalCostUsd + strong.totalCostUsd,
      totalInputTokens: cheap.totalInputTokens + strong.totalInputTokens,
      totalOutputTokens: cheap.totalOutputTokens + strong.totalOutputTokens,
      totalToolCalls: (cheap.totalToolCalls ?? 0) + (strong.totalToolCalls ?? 0),
    };
    return {
      result: merged,
      modelMode: "CASCADE",
      modeDetail: {
        ...detail,
        escalated: true,
        escalation: "low_confidence",
        strongCostUsd: strong.totalCostUsd,
        attempts: [
          cheapAttempt,
          {
            role: "strong",
            model: clip(strongModel),
            actualModel: clip(strong.model),
            actualProvider: clip(strong.provider),
            costUsd: strong.totalCostUsd,
            confidence: confidenceOf(strong),
          },
        ],
      },
    };
  }

  async function runCompare(): Promise<ModelModeRunResult> {
    if (!isCompareConfigValid(config)) return direct({ fallback: "compare_needs_2_3_models" });
    const tools = Array.isArray(agent.tools) ? agent.tools : [];
    if (tools.length > 0) return direct({ fallback: "compare_requires_toolless_agent" });

    const models = config.compareModels as string[];
    // Araçsız çalışır: toolNames boş, connector araçları (extraTools) da verilmez.
    const { extraTools: _drop, ...toolless } = loopParams;
    void _drop;
    const candidates: Array<{
      model: string;
      provider: string | null;
      actualModel: string | null;
      actualProvider: string | null;
      costUsd: number;
      confidence: number | null;
      selected: boolean;
      skipped?: string;
      run?: AgentLoopResult;
    }> = [];
    let spent = 0;
    let ranAny = false;
    for (const model of models) {
      let budget: number | undefined;
      if (ranAny) {
        const allow = allowance(spent);
        if (allow.reason) {
          candidates.push({ model: clip(model) as string, provider: null, actualModel: null, actualProvider: null, costUsd: 0, confidence: null, selected: false, skipped: allow.reason });
          continue;
        }
        budget = allow.usd;
      }
      const run = await runLoop({ ...toolless, toolNames: [], model, ...(budget !== undefined ? { budgetUsd: budget } : {}) });
      ranAny = true;
      spent += run.totalCostUsd;
      candidates.push({
        model: clip(model) as string,
        provider: clip(run.provider),
        actualModel: clip(run.model),
        actualProvider: clip(run.provider),
        costUsd: run.totalCostUsd,
        confidence: confidenceOf(run),
        selected: false,
        run,
      });
    }

    let winner: (typeof candidates)[number] | undefined;
    for (const c of candidates) {
      if (!c.run || c.confidence === null) continue;
      if (!winner || c.confidence > (winner.confidence as number)) winner = c;
    }
    // İlk aday her zaman çalışır; winner tanımsız olamaz.
    const chosen = winner as (typeof candidates)[number] & { run: AgentLoopResult };
    chosen.selected = true;
    const result: AgentLoopResult = {
      ...chosen.run,
      totalCostUsd: candidates.reduce((s, c) => s + (c.run?.totalCostUsd ?? 0), 0),
      totalInputTokens: candidates.reduce((s, c) => s + (c.run?.totalInputTokens ?? 0), 0),
      totalOutputTokens: candidates.reduce((s, c) => s + (c.run?.totalOutputTokens ?? 0), 0),
      totalToolCalls: 0,
    };
    const actuals = candidates.filter((c) => c.run).map((c) => c.actualModel);
    const sameModel = actuals.length >= 2 && actuals.every((m) => m !== null && m === actuals[0]);
    return {
      result,
      modelMode: "COMPARE",
      modeDetail: {
        ...base,
        effective: "COMPARE",
        budgetUsdCap: config.budgetUsdCap ?? null,
        ...(sameModel ? { warning: "candidates_resolved_to_same_model" } : {}),
        candidates: candidates.map(({ run: _r, ...c }) => {
          void _r;
          return c;
        }),
      },
    };
  }
}

export type { ModelModeConfig };

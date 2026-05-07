"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";

interface OnboardingStatus {
  completed: boolean;
  progress: number;
  steps: Record<string, boolean>;
}

// Stable ids + icons; labels and descriptions resolve at render via
// useTranslations so a Turkish user sees "İçerik" while DB enum stays
// "content".
const PRIMITIVES = [
  { id: "acquisition", icon: "podcasts" },
  { id: "sales", icon: "work" },
  { id: "delivery", icon: "deployed_code" },
  { id: "content", icon: "edit_note" },
  { id: "operations", icon: "account_tree" },
  { id: "finance", icon: "payments" },
  { id: "analytics", icon: "query_stats" },
  { id: "memory", icon: "memory" },
  { id: "governance", icon: "security" },
];

const INDUSTRIES = [
  { id: "saas", icon: "cloud" },
  { id: "agency", icon: "business_center" },
  { id: "ecommerce", icon: "shopping_bag" },
  { id: "consulting", icon: "handshake" },
  { id: "creator", icon: "person_celebrate" },
  { id: "b2b_sales", icon: "sales" },
  { id: "real_estate", icon: "home_work" },
  { id: "marketing", icon: "campaign" },
  { id: "automation", icon: "smart_toy" },
  { id: "support", icon: "support_agent" },
];

interface CatalogBlueprint {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  primitives: string[];
  agentCount: number;
  pipelineCount: number;
  estimatedRunCost: string;
}

// Onboarding wizard state is persisted to localStorage so a refresh, browser
// crash, or "I'll come back later" doesn't reset the user to step 0. Single
// key holds the whole wizard snapshot; we restore on mount and write on
// every change. Once the company is launched we delete the key.
const ONBOARDING_DRAFT_KEY = "aicos-onboarding-draft";

type OnboardingDraft = {
  step: number;
  description: string;
  selectedPrimitives: string[];
  companyName: string;
  niche: string;
  targetAudience: string;
  selectedIndustry: string | null;
  selectedUseCases: string[];
  selectedBlueprintSlug: string | null;
};

function loadOnboardingDraft(): Partial<OnboardingDraft> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ONBOARDING_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function saveOnboardingDraft(d: OnboardingDraft) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify(d));
  } catch {
    /* private mode / quota exceeded — silently ignore */
  }
}

function clearOnboardingDraft() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(ONBOARDING_DRAFT_KEY);
  } catch {
    /* same — ignore */
  }
}

export default function OnboardingPage() {
  const t = useTranslations();
  // i18n arrays read once via t.raw — useCases, stepLabels, suggestions all
  // ship as ordered lists so per-locale ordering can adjust without code
  // changes. Stable indices (0..N-1) tie elements together.
  const STEP_LABELS = t.raw("onboarding.stepLabels") as string[];
  const USE_CASES = t.raw("onboarding.useCases") as string[];
  const SUGGESTIONS = t.raw("onboarding.suggestions") as string[];

  const router = useRouter();
  const { token, hydrated } = useAuthGuard();
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [step, setStep] = useState(0);
  const [description, setDescription] = useState("");
  const [selectedPrimitives, setSelectedPrimitives] = useState<string[]>(["content", "acquisition"]);
  const [companyName, setCompanyName] = useState(t("onboarding.companyNamePlaceholder"));
  const [niche, setNiche] = useState("");
  const [targetAudience, setTargetAudience] = useState("");
  const [selectedIndustry, setSelectedIndustry] = useState<string | null>(null);
  const [selectedUseCases, setSelectedUseCases] = useState<string[]>([]);
  const [suggestedBlueprints, setSuggestedBlueprints] = useState<CatalogBlueprint[]>([]);
  const [loadingBlueprints, setLoadingBlueprints] = useState(false);
  const [selectedBlueprintSlug, setSelectedBlueprintSlug] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [descTouched, setDescTouched] = useState(false);
  const [descError, setDescError] = useState<string | null>(null);
  // BYOK gate — onboarding is the first place a tenant runs an agent,
  // and without an Anthropic key (or other provider) every Hero pipeline
  // run will 503. Surface this BEFORE they get to "Launch" so the
  // "10 minutes to first deploy" promise doesn't break on a hidden
  // prerequisite.
  const [aiKeyConfigured, setAiKeyConfigured] = useState<boolean | null>(null);
  // True once we've finished checking localStorage on mount; we use this to
  // gate the autosave effect below so the first run doesn't immediately
  // overwrite a saved draft with the empty initial state.
  const [draftHydrated, setDraftHydrated] = useState(false);

  // Restore wizard state from localStorage on mount + pull hero textarea
  // description from sessionStorage if user typed on landing page first.
  useEffect(() => {
    const draft = loadOnboardingDraft();
    if (draft) {
      if (typeof draft.step === "number") setStep(draft.step);
      if (typeof draft.description === "string") setDescription(draft.description);
      if (Array.isArray(draft.selectedPrimitives)) setSelectedPrimitives(draft.selectedPrimitives);
      if (typeof draft.companyName === "string") setCompanyName(draft.companyName);
      if (typeof draft.niche === "string") setNiche(draft.niche);
      if (typeof draft.targetAudience === "string") setTargetAudience(draft.targetAudience);
      if (typeof draft.selectedIndustry === "string" || draft.selectedIndustry === null) setSelectedIndustry(draft.selectedIndustry ?? null);
      if (Array.isArray(draft.selectedUseCases)) setSelectedUseCases(draft.selectedUseCases);
      if (typeof draft.selectedBlueprintSlug === "string" || draft.selectedBlueprintSlug === null) setSelectedBlueprintSlug(draft.selectedBlueprintSlug ?? null);
    } else {
      // First-time visitor — pull the description they typed on the landing
      // page hero textarea (if any). One-shot read: we then clear it so a
      // returning user doesn't see a stale prompt resurface.
      try {
        const fromHero = sessionStorage.getItem("aicos-build-desc");
        if (fromHero) {
          setDescription(fromHero);
          sessionStorage.removeItem("aicos-build-desc");
        }
      } catch { /* ignore */ }
    }
    setDraftHydrated(true);
  }, []);

  // Persist on every change (after hydration completes — see draftHydrated).
  useEffect(() => {
    if (!draftHydrated) return;
    saveOnboardingDraft({
      step,
      description,
      selectedPrimitives,
      companyName,
      niche,
      targetAudience,
      selectedIndustry,
      selectedUseCases,
      selectedBlueprintSlug,
    });
  }, [draftHydrated, step, description, selectedPrimitives, companyName, niche, targetAudience, selectedIndustry, selectedUseCases, selectedBlueprintSlug]);

  useEffect(() => {
    if (!token) return;
    api.onboardingStatus(token).then(setStatus).catch(() => {});
    api.getAIConfig(token).then((cfg) => setAiKeyConfigured(cfg.hasApiKey)).catch(() => setAiKeyConfigured(false));
  }, [token]);

  // Blueprint catalog removed (decision 2026-04-30): users define their
  // own company end-to-end — the AI builder writes the agents and
  // pipeline from a free-text description, no pre-canned templates.
  // Industry is still captured because it primes the builder's LLM
  // context downstream.

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(0,209,255,0.3)", borderTopColor: "#00d1ff" }} />
    </div>
  );

  function togglePrimitive(id: string) {
    setSelectedPrimitives((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  }

  function toggleUseCase(uc: string) {
    setSelectedUseCases((prev) =>
      prev.includes(uc) ? prev.filter((u) => u !== uc) : [...prev, uc]
    );
  }

  function applyBlueprintPrimitives(bp: CatalogBlueprint) {
    setSelectedBlueprintSlug(bp.slug);
    setSelectedPrimitives(bp.primitives.map((p) => p.toLowerCase()));
  }

  async function handleLaunch() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.createHeroCompany(token!, {
        companyName: companyName.trim() || undefined,
        niche: niche.trim() || undefined,
        targetAudience: targetAudience.trim() || undefined,
      });
      setResult(res);
      clearOnboardingDraft();
      api.onboardingStatus(token!).then(setStatus).catch(() => {});
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
  }

  const progressPct = status ? Math.round(status.progress * 100) : 0;

  // Already completed
  if (result || status?.steps?.heroCompanyCreated) {
    return (
      <div className="flex items-center justify-center min-h-screen px-6" style={{ background: "#0a0d14" }}>
        <div
          className="w-full max-w-[520px] glass-card rounded-2xl p-8 text-center"
          style={{ border: "1px solid rgba(52,211,153,0.2)" }}
        >
          <div
            className="w-16 h-16 rounded-2xl mx-auto mb-5 flex items-center justify-center"
            style={{ background: "rgba(52,211,153,0.1)" }}
          >
            <span className="material-symbols-outlined text-3xl" style={{ color: "#34d399" }}>
              check_circle
            </span>
          </div>
          <h2 className="font-headline font-bold text-2xl mb-2" style={{ color: "#e1e2eb" }}>
            {result?.company?.name ?? t("onboarding.successCompanyFallback")}{t("onboarding.successLiveSuffix")}
          </h2>
          <p className="text-sm mb-6" style={{ color: "#859399" }}>
            {result?.fromBlueprint
              ? t("onboarding.successFromBlueprint")
              : (result?.company?.description ?? t("onboarding.successDefault"))}
          </p>
          {result && !result.fromBlueprint && (
            <div className="flex justify-center gap-8 mb-6">
              <div>
                <p className="text-2xl font-bold font-headline" style={{ color: "#34d399" }}>
                  {result.agents?.length ?? 0}
                </p>
                <p className="text-xs" style={{ color: "#859399" }}>{t("onboarding.agents")}</p>
              </div>
              <div>
                <p className="text-2xl font-bold font-headline" style={{ color: "#00d1ff" }}>1</p>
                <p className="text-xs" style={{ color: "#859399" }}>{t("onboarding.pipeline")}</p>
              </div>
            </div>
          )}
          {aiKeyConfigured === false && (
            <div
              className="mb-6 px-4 py-3 rounded-xl text-left"
              style={{ background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.25)" }}
            >
              <div className="flex items-start gap-2">
                <span className="material-symbols-outlined text-base mt-0.5" style={{ color: "#fbbf24" }}>key</span>
                <div className="flex-1">
                  <p className="font-semibold text-sm mb-1" style={{ color: "#fde68a" }}>
                    {t("onboarding.byokTitle")}
                  </p>
                  <p className="text-xs leading-relaxed mb-3" style={{ color: "#f59e0b" }}>
                    {t("onboarding.byokSubtitle")}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
                    <Link
                      href="/settings#ai-provider"
                      className="flex flex-col gap-1 p-2.5 rounded-lg text-left transition-all hover:brightness-125"
                      style={{ background: "rgba(0,209,255,0.08)", border: "1px solid rgba(0,209,255,0.25)" }}
                    >
                      <span className="text-[11px] font-bold" style={{ color: "#00d1ff" }}>{t("onboarding.byokCloudTitle")}</span>
                      <span className="text-[10px]" style={{ color: "#859399" }}>{t("onboarding.byokCloudDesc")}</span>
                    </Link>
                    <Link
                      href="/settings#ai-provider"
                      className="flex flex-col gap-1 p-2.5 rounded-lg text-left transition-all hover:brightness-125"
                      style={{ background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.25)" }}
                    >
                      <span className="text-[11px] font-bold" style={{ color: "#34d399" }}>{t("onboarding.byokSelfTitle")}</span>
                      <span className="text-[10px]" style={{ color: "#859399" }}>{t("onboarding.byokSelfDesc")}</span>
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          )}
          <div className="flex gap-3 justify-center">
            <Link
              href={aiKeyConfigured === false ? "/settings#ai-provider" : "/companies"}
              className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110"
              style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
            >
              {aiKeyConfigured === false ? t("onboarding.addApiKey") : t("onboarding.viewCompanies")}
            </Link>
            <Link
              href="/dashboard"
              className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-80"
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}
            >
              {t("onboarding.dashboard")}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex neural-mesh" style={{ background: "#0a0d14" }}>
      {/* Ambient bg */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-0 left-1/4 w-96 h-96 rounded-full opacity-[0.05] blur-3xl" style={{ background: "radial-gradient(circle, #00d1ff, transparent)" }} />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 rounded-full opacity-[0.05] blur-3xl" style={{ background: "radial-gradient(circle, #6d11ad, transparent)" }} />
        <div className="absolute inset-0 opacity-[0.02]" style={{ backgroundImage: "radial-gradient(circle, #ffffff 1px, transparent 1px)", backgroundSize: "32px 32px" }} />
      </div>

      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 py-12">
        {/* Header */}
        <div className="w-full max-w-[700px] mb-8">
          <div className="flex items-center gap-3 mb-6">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
            >
              <span className="font-bold text-xs text-white">AI</span>
            </div>
            <span className="font-headline font-bold" style={{ color: "#e1e2eb" }}>Braavolabs</span>
          </div>

          {/* Progress steps */}
          <div className="flex items-center gap-2">
            {STEP_LABELS.map((label, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="flex items-center gap-2">
                  <div
                    className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all"
                    style={{
                      background: i < step ? "#00d1ff" : i === step ? "rgba(0,209,255,0.15)" : "rgba(255,255,255,0.04)",
                      border: i === step ? "1.5px solid #00d1ff" : i < step ? "none" : "1.5px solid rgba(255,255,255,0.08)",
                      color: i <= step ? (i < step ? "#0a0d14" : "#00d1ff") : "#3c494e",
                    }}
                  >
                    {i < step ? "✓" : i + 1}
                  </div>
                  <span
                    className="text-xs font-medium hidden sm:block"
                    style={{ color: i === step ? "#e1e2eb" : i < step ? "#bbc9cf" : "#3c494e" }}
                  >
                    {label}
                  </span>
                </div>
                {i < STEP_LABELS.length - 1 && (
                  <div className="w-8 h-px mx-1" style={{ background: i < step ? "#00d1ff" : "rgba(255,255,255,0.06)" }} />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Step card */}
        <div className="w-full max-w-[700px] glass-card rounded-2xl p-8 relative overflow-hidden max-h-[calc(100vh-200px)] overflow-y-auto">

          {/* Step 0: Industry & Use Case Selection */}
          {step === 0 && (
            <div>
              <h2 className="font-headline font-bold text-2xl mb-2" style={{ color: "#e1e2eb" }}>
                {t("onboarding.step0Title")}
              </h2>
              <p className="text-sm mb-6" style={{ color: "#859399" }}>
                {t("onboarding.step0Subtitle")}
              </p>

              {/* Industry grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-6">
                {INDUSTRIES.map((ind) => {
                  const selected = selectedIndustry === ind.id;
                  return (
                    <button
                      key={ind.id}
                      onClick={() => setSelectedIndustry(ind.id)}
                      className="p-3 rounded-xl text-left transition-all hover:scale-[1.02]"
                      style={{
                        background: selected ? "rgba(0,209,255,0.08)" : "rgba(255,255,255,0.03)",
                        border: selected ? "1.5px solid rgba(0,209,255,0.4)" : "1.5px solid rgba(255,255,255,0.06)",
                      }}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="material-symbols-outlined text-base" style={{ color: selected ? "#00d1ff" : "#859399" }}>
                          {ind.icon}
                        </span>
                        <span className="text-xs font-semibold" style={{ color: selected ? "#e1e2eb" : "#bbc9cf" }}>{t(`onboarding.industries.${ind.id}.label`)}</span>
                      </div>
                      <p className="text-[10px]" style={{ color: "#3c494e" }}>{t(`onboarding.industries.${ind.id}.desc`)}</p>
                    </button>
                  );
                })}
              </div>

              {/* Use case selection */}
              <div className="mb-6">
                <p className="text-xs font-semibold mb-2" style={{ color: "#bbc9cf" }}>{t("onboarding.automateQuestion")} <span style={{ color: "#3c494e", fontWeight: 400 }}>{t("onboarding.automateHint")}</span></p>
                <div className="flex flex-wrap gap-2">
                  {USE_CASES.map((uc) => {
                    const selected = selectedUseCases.includes(uc);
                    return (
                      <button
                        key={uc}
                        onClick={() => toggleUseCase(uc)}
                        className="px-3 py-1.5 rounded-full text-xs font-medium transition-all"
                        style={{
                          background: selected ? "rgba(109,17,173,0.15)" : "rgba(255,255,255,0.03)",
                          border: selected ? "1px solid rgba(109,17,173,0.5)" : "1px solid rgba(255,255,255,0.08)",
                          color: selected ? "#c084fc" : "#859399",
                        }}
                      >
                        {uc}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Suggested blueprints */}
              {selectedIndustry && (
                <div className="mb-6">
                  <p className="text-xs font-semibold mb-2" style={{ color: "#bbc9cf" }}>
                    {t("onboarding.recommendedBlueprints")}
                    <span className="ml-1 font-normal" style={{ color: "#3c494e" }}>{t("onboarding.blueprintsHint")}</span>
                  </p>
                  {loadingBlueprints ? (
                    <div className="flex gap-2">
                      {[1, 2, 3].map((i) => (
                        <div key={i} className="flex-1 h-20 rounded-xl animate-shimmer" style={{ background: "rgba(255,255,255,0.04)" }} />
                      ))}
                    </div>
                  ) : suggestedBlueprints.length > 0 ? (
                    <div className="flex flex-col gap-2">
                      {suggestedBlueprints.map((bp) => {
                        const isSelected = selectedBlueprintSlug === bp.slug;
                        return (
                          <button
                            key={bp.slug}
                            onClick={() => {
                              applyBlueprintPrimitives(bp);
                              setCompanyName(bp.title);
                            }}
                            className="w-full p-3 rounded-xl text-left transition-all hover:brightness-110"
                            style={{
                              background: isSelected ? "rgba(0,209,255,0.08)" : "rgba(255,255,255,0.03)",
                              border: isSelected ? "1.5px solid rgba(0,209,255,0.4)" : "1.5px solid rgba(255,255,255,0.06)",
                            }}
                          >
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-0.5">
                                  <span className="text-xs font-semibold" style={{ color: isSelected ? "#00d1ff" : "#e1e2eb" }}>{bp.title}</span>
                                  {isSelected && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded font-bold" style={{ background: "rgba(0,209,255,0.15)", color: "#00d1ff" }}>{t("onboarding.blueprintSelectedBadge")}</span>
                                  )}
                                </div>
                                <p className="text-[10px] line-clamp-1" style={{ color: "#859399" }}>{bp.description}</p>
                              </div>
                              <div className="flex items-center gap-2 ml-3 shrink-0">
                                <span className="text-[10px]" style={{ color: "#3c494e" }}>{bp.agentCount}a · {bp.pipelineCount}p</span>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs" style={{ color: "#3c494e" }}>{t("onboarding.noBlueprints")}</p>
                  )}
                </div>
              )}

              <div className="flex justify-between items-center sticky bottom-0 pt-4 pb-1 -mb-4 z-10" style={{ background: "linear-gradient(to top, rgba(15,18,25,1) 60%, rgba(15,18,25,0))" }}>
                <p className="text-xs" style={{ color: "#3c494e" }}>
                  {!selectedIndustry && t("onboarding.selectIndustryHint")}
                </p>
                <button
                  onClick={() => setStep(1)}
                  disabled={!selectedIndustry}
                  className="px-6 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-40"
                  style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", boxShadow: "0 0 20px rgba(0,209,255,0.2)" }}
                >
                  {t("onboarding.continueButton")}
                </button>
              </div>
            </div>
          )}

          {/* Step 1: Company description */}
          {step === 1 && (
            <div>
              <h2 className="font-headline font-bold text-2xl mb-2" style={{ color: "#e1e2eb" }}>
                {t("onboarding.step1Title")}
              </h2>
              <p className="text-sm mb-6" style={{ color: "#859399" }}>
                {t("onboarding.step1Subtitle")}
              </p>

              <div className="mb-4">
                <label className="block text-xs font-semibold mb-1.5" style={{ color: "#bbc9cf" }}>{t("onboarding.fieldCompanyName")}</label>
                <input
                  type="text"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl text-sm outline-none transition-all mb-4"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }}
                  placeholder={t("onboarding.companyNamePlaceholder")}
                />
                <label className="block text-xs font-semibold mb-1.5" style={{ color: "#bbc9cf" }}>{t("onboarding.fieldDescribeBusiness")}</label>
                <div className="relative">
                  <textarea
                    rows={5}
                    value={description}
                    onChange={(e) => { setDescription(e.target.value); setDescError(null); }}
                    className="w-full px-4 py-3 rounded-xl text-sm outline-none resize-none transition-all"
                    style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb", lineHeight: 1.7 }}
                    placeholder={t("onboarding.descriptionPlaceholder")}
                    onFocus={(e) => { e.currentTarget.style.border = "1px solid rgba(0,209,255,0.4)"; }}
                    onBlur={(e) => { e.currentTarget.style.border = "1px solid rgba(255,255,255,0.08)"; }}
                  />
                  <span className="absolute bottom-2 right-3 text-xs" style={{ color: "#3c494e" }}>{description.length} / 500</span>
                </div>
                {descError && (
                  <p className="mt-1.5 text-xs" style={{ color: "#f87171" }}>{descError}</p>
                )}
              </div>

              {/* Suggestions */}
              {!selectedBlueprintSlug && (
                <div className="mb-6">
                  <p className="text-xs mb-2" style={{ color: "#859399" }}>{t("onboarding.needInspiration")}</p>
                  <div className="flex flex-wrap gap-2">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        onClick={() => setDescription(t("onboarding.suggestionTemplate", { kind: s.toLowerCase() }))}
                        className="px-3 py-1.5 rounded-full text-xs font-medium transition-all hover:opacity-80"
                        style={{ background: "rgba(0,209,255,0.08)", border: "1px solid rgba(0,209,255,0.25)", color: "#00d1ff" }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {selectedBlueprintSlug && (
                <div className="mb-6 px-4 py-3 rounded-xl" style={{ background: "rgba(0,209,255,0.06)", border: "1px solid rgba(0,209,255,0.15)" }}>
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-sm" style={{ color: "#00d1ff" }}>auto_awesome</span>
                    <span className="text-xs" style={{ color: "#a4e6ff" }}>{t("onboarding.blueprintSelected")}</span>
                    <button onClick={() => setSelectedBlueprintSlug(null)} className="ml-auto text-xs" style={{ color: "#3c494e" }}>{t("onboarding.removeBlueprint")}</button>
                  </div>
                </div>
              )}

              {descTouched && !description.trim() && !selectedBlueprintSlug && (
                <p className="text-xs mb-3" style={{ color: "#f87171" }}>{t("onboarding.describeOrSelectError")}</p>
              )}

              <div className="flex justify-between">
                <button onClick={() => setStep(0)} className="px-5 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}>
                  {t("onboarding.backButton")}
                </button>
                <button onClick={() => { setDescTouched(true); if (!description.trim() && !selectedBlueprintSlug) { setDescError(t("onboarding.describeError")); return; } setDescError(null); setStep(2); }} className="px-6 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90" style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", boxShadow: "0 0 20px rgba(0,209,255,0.2)" }}>
                  {t("onboarding.continueButton")}
                </button>
              </div>
            </div>
          )}

          {/* Step 2: Primitives */}
          {step === 2 && (
            <div>
              <h2 className="font-headline font-bold text-2xl mb-2" style={{ color: "#e1e2eb" }}>
                {t("onboarding.step2Title")}
              </h2>
              <p className="text-sm mb-6" style={{ color: "#859399" }}>
                {selectedBlueprintSlug
                  ? t("onboarding.step2SubtitleBlueprint")
                  : t("onboarding.step2SubtitleDefault")}
              </p>

              <div className="grid grid-cols-3 gap-3 mb-6">
                {PRIMITIVES.map((p) => {
                  const selected = selectedPrimitives.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      onClick={() => togglePrimitive(p.id)}
                      className="p-4 rounded-xl text-left transition-all hover:scale-[1.02]"
                      style={{
                        background: selected ? "rgba(0,209,255,0.08)" : "rgba(255,255,255,0.03)",
                        border: selected ? "1.5px solid rgba(0,209,255,0.4)" : "1.5px solid rgba(255,255,255,0.06)",
                      }}
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <span
                          className="material-symbols-outlined text-lg"
                          style={{ color: selected ? "#00d1ff" : "#859399" }}
                        >
                          {p.icon}
                        </span>
                      </div>
                      <p className="text-sm font-semibold" style={{ color: selected ? "#e1e2eb" : "#bbc9cf" }}>{t(`onboarding.primitives.${p.id}.label`)}</p>
                      <p className="text-xs mt-0.5" style={{ color: "#859399" }}>{t(`onboarding.primitives.${p.id}.desc`)}</p>
                    </button>
                  );
                })}
              </div>

              <div className="flex justify-between">
                <button onClick={() => setStep(1)} className="px-5 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}>
                  {t("onboarding.backButton")}
                </button>
                <button onClick={() => setStep(3)} className="px-6 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90" style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", boxShadow: "0 0 20px rgba(0,209,255,0.2)" }}>
                  {t("onboarding.continueButton")}
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Channels */}
          {step === 3 && (
            <div>
              <h2 className="font-headline font-bold text-2xl mb-2" style={{ color: "#e1e2eb" }}>
                {t("onboarding.step3Title")}
              </h2>
              <p className="text-sm mb-6" style={{ color: "#859399" }}>
                {t("onboarding.step3Subtitle")}
              </p>

              <div className="space-y-4 mb-6">
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: "#bbc9cf" }}>{t("onboarding.fieldNiche")} <span style={{ color: "#3c494e", fontWeight: 400 }}>{t("onboarding.optional")}</span></label>
                  <input
                    type="text"
                    value={niche}
                    onChange={(e) => setNiche(e.target.value)}
                    className="w-full px-4 py-2.5 rounded-xl text-sm outline-none transition-all"
                    style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }}
                    placeholder={t("onboarding.nichePlaceholder")}
                    onFocus={(e) => { e.currentTarget.style.border = "1px solid rgba(0,209,255,0.4)"; }}
                    onBlur={(e) => { e.currentTarget.style.border = "1px solid rgba(255,255,255,0.08)"; }}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: "#bbc9cf" }}>{t("onboarding.fieldTargetAudience")} <span style={{ color: "#3c494e", fontWeight: 400 }}>{t("onboarding.optional")}</span></label>
                  <input
                    type="text"
                    value={targetAudience}
                    onChange={(e) => setTargetAudience(e.target.value)}
                    className="w-full px-4 py-2.5 rounded-xl text-sm outline-none transition-all"
                    style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }}
                    placeholder={t("onboarding.audiencePlaceholder")}
                    onFocus={(e) => { e.currentTarget.style.border = "1px solid rgba(0,209,255,0.4)"; }}
                    onBlur={(e) => { e.currentTarget.style.border = "1px solid rgba(255,255,255,0.08)"; }}
                  />
                </div>

                {/* Active channels */}
                <div>
                  <label className="block text-xs font-semibold mb-2" style={{ color: "#bbc9cf" }}>{t("onboarding.activeChannelsTitle")}</label>
                  <div className="flex flex-wrap gap-3">
                    {[
                      { name: "TikTok", icon: "🎵", included: true },
                      { name: "LinkedIn", icon: "💼", included: true },
                      { name: "Twitter/X", icon: "𝕏", included: false },
                      { name: "Instagram", icon: "📸", included: false },
                    ].map((ch) => (
                      <div key={ch.name} className="flex items-center gap-2 px-3 py-2 rounded-xl flex-shrink-0" style={{ background: ch.included ? "rgba(0,209,255,0.08)" : "rgba(255,255,255,0.03)", border: `1.5px solid ${ch.included ? "rgba(0,209,255,0.3)" : "rgba(255,255,255,0.05)"}`, opacity: ch.included ? 1 : 0.5 }}>
                        <span className="text-sm">{ch.icon}</span>
                        <span className="text-xs" style={{ color: ch.included ? "#bbc9cf" : "#3c494e" }}>{ch.name}</span>
                        {ch.included && <span className="text-[10px] font-semibold" style={{ color: "#00d1ff" }}>✓</span>}
                      </div>
                    ))}
                  </div>
                  <p className="text-xs mt-2" style={{ color: "#3c494e" }}>{t("onboarding.upgradeToProForChannels")}</p>
                </div>
              </div>

              <div className="flex justify-between">
                <button onClick={() => setStep(2)} className="px-5 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}>
                  {t("onboarding.backButton")}
                </button>
                <button onClick={() => setStep(4)} className="px-6 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90" style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", boxShadow: "0 0 20px rgba(0,209,255,0.2)" }}>
                  {t("onboarding.continueButton")}
                </button>
              </div>
            </div>
          )}

          {/* Step 4: Launch */}
          {step === 4 && (
            <div>
              <h2 className="font-headline font-bold text-2xl mb-2" style={{ color: "#e1e2eb" }}>
                {t("onboarding.step4Title")}
              </h2>
              <p className="text-sm mb-6" style={{ color: "#859399" }}>
                {t("onboarding.step4Subtitle")}
              </p>

              {/* Summary */}
              <div className="rounded-xl p-5 mb-5 space-y-3" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <SummaryRow label={t("onboarding.summaryCompanyName")} value={companyName || t("onboarding.companyNamePlaceholder")} />
                <SummaryRow label={t("onboarding.summaryIndustry")} value={selectedIndustry ? t(`onboarding.industries.${selectedIndustry}.label`) : "—"} />
                {selectedBlueprintSlug && (
                  <SummaryRow label={t("onboarding.summaryBlueprint")} value={suggestedBlueprints.find((b) => b.slug === selectedBlueprintSlug)?.title ?? selectedBlueprintSlug} highlight />
                )}
                <SummaryRow label={t("onboarding.summaryPrimitives")} value={t("onboarding.summaryPrimitivesValueTemplate", { count: selectedPrimitives.length })} highlight />
                <SummaryRow label={t("onboarding.summaryChannels")} value="TikTok, LinkedIn" />
                {niche && <SummaryRow label={t("onboarding.summaryNiche")} value={niche} />}
                {targetAudience && <SummaryRow label={t("onboarding.summaryAudience")} value={targetAudience} />}
              </div>

              {error && (
                <div className="mb-4 px-4 py-3 rounded-xl text-sm" style={{ background: "rgba(255,180,171,0.08)", border: "1px solid rgba(255,180,171,0.2)", color: "#ffb4ab" }}>
                  {error}
                </div>
              )}

              <div className="flex justify-between">
                <button onClick={() => setStep(3)} className="px-5 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}>
                  {t("onboarding.backButton")}
                </button>
                <button
                  onClick={handleLaunch}
                  disabled={loading}
                  className="px-8 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-50"
                  style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", boxShadow: "0 0 24px rgba(0,209,255,0.3)" }}
                >
                  {loading ? t("onboarding.creatingButton") : t("onboarding.launchButton")}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Onboarding progress bar (if exists) */}
        {status && (
          <div
            className="w-full max-w-[700px] mt-5 glass-card rounded-xl p-4 flex items-center gap-4"
          >
            <div className="flex-1">
              <div className="flex justify-between mb-1">
                <span className="text-xs" style={{ color: "#859399" }}>{t("onboarding.onboardingProgress")}</span>
                <span className="text-xs font-bold" style={{ color: "#00d1ff" }}>{progressPct}%</span>
              </div>
              <div className="h-1 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.05)" }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${progressPct}%`, background: "linear-gradient(90deg, #00d1ff, #6d11ad)" }}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-sm" style={{ color: "#859399" }}>{label}</span>
      <span className="text-sm font-semibold" style={{ color: highlight ? "#00d1ff" : "#bbc9cf" }}>{value}</span>
    </div>
  );
}

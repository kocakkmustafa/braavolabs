"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { useAppStore, captureAuthSession, isAuthSessionCurrent } from "../../lib/store";

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
  tenantId: string;
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

function loadOnboardingDraft(tenantId: string): Partial<OnboardingDraft> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ONBOARDING_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || parsed.tenantId !== tenantId) {
      window.localStorage.removeItem(ONBOARDING_DRAFT_KEY);
      return null;
    }
    return parsed;
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
  const { token, hydrated } = useAuthGuard();
  const revision = useAppStore((state) => state.sessionRevision);
  const tenantId = useAppStore((state) => state.tenantId);
  if (!hydrated || !token || !tenantId) return null;
  // Authentication changes reset in-memory wizard state as well as storage.
  return <OnboardingWizard key={revision} tenantId={tenantId} />;
}

function OnboardingWizard({ tenantId }: { tenantId: string }) {
  const t = useTranslations();
  // i18n arrays read once via t.raw — useCases, stepLabels, suggestions all
  // ship as ordered lists so per-locale ordering can adjust without code
  // changes. Stable indices (0..N-1) tie elements together.
  const STEP_LABELS = t.raw("app.onboarding.stepLabels") as string[];
  const USE_CASES = t.raw("app.onboarding.useCases") as string[];
  const SUGGESTIONS = t.raw("app.onboarding.suggestions") as string[];

  const router = useRouter();
  const mounted = useRef(true);
  const owner = useRef(captureAuthSession());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const { token, hydrated } = useAuthGuard();
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [step, setStep] = useState(0);
  const [description, setDescription] = useState("");
  const [selectedPrimitives, setSelectedPrimitives] = useState<string[]>(["content", "acquisition"]);
  const [companyName, setCompanyName] = useState(t("app.onboarding.companyNamePlaceholder"));
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
    if (!isAuthSessionCurrent(owner.current)) return;
    const draft = loadOnboardingDraft(tenantId);
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
    if (!draftHydrated || !isAuthSessionCurrent(owner.current)) return;
    saveOnboardingDraft({
      tenantId,
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
    const session = captureAuthSession();
    let active = true;
    const current = () => active && isAuthSessionCurrent(session);
    api.onboardingStatus(token).then((value) => { if (current()) setStatus(value); }).catch(() => {});
    api.getAIConfig(token).then((cfg) => { if (current()) setAiKeyConfigured(cfg.hasApiKey); })
      .catch(() => { if (current()) setAiKeyConfigured(false); });
    return () => { active = false; };
  }, [token]);

  // Blueprint catalog removed (decision 2026-04-30): users define their
  // own company end-to-end — the AI builder writes the agents and
  // pipeline from a free-text description, no pre-canned templates.
  // Industry is still captured because it primes the builder's LLM
  // context downstream.

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(59,130,246,0.3)", borderTopColor: "#3B82F6" }} />
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
    if (!token) return;
    const session = captureAuthSession();
    const current = () => mounted.current && isAuthSessionCurrent(session);
    setLoading(true);
    setError(null);
    try {
      const res = await api.createHeroCompany(token!, {
        companyName: companyName.trim() || undefined,
        niche: niche.trim() || undefined,
        targetAudience: targetAudience.trim() || undefined,
      });
      if (!current()) return;
      setResult(res);
      clearOnboardingDraft();
      api.onboardingStatus(token!).then((value) => { if (current()) setStatus(value); }).catch(() => {});
    } catch (err) {
      if (current()) setError((err as Error).message);
    } finally {
      if (current()) setLoading(false);
    }
  }

  const progressPct = status ? Math.round(status.progress * 100) : 0;
  // Arc progress bar width — steps 0-4 maps to 16%–100% (6 total states like the mock)
  const TOTAL_STEPS = STEP_LABELS.length;
  const barWidth = Math.round(((step + 1) / (TOTAL_STEPS + 1)) * 100);

  // Already completed
  if (result || status?.steps?.heroCompanyCreated) {
    return (
      <div className="bv-mesh min-h-screen flex flex-col" style={{ overflow: "hidden" }}>
        {/* Progress bar — full */}
        <div className="h-[3px] flex-none" style={{ background: "var(--bv-steel-shadow)" }}>
          <div className="h-full transition-all duration-700" style={{ width: "100%", background: "linear-gradient(90deg, var(--bv-cobalt-glow), var(--bv-cobalt-deep))", boxShadow: "0 0 14px var(--bv-cobalt-glow)" }} />
        </div>

        {/* Top bar */}
        <div className="flex items-center px-7 py-5 flex-none">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="bv-avatar w-8 h-8 rounded-lg text-xs font-bold">AI</div>
            <span className="bv-title text-sm font-semibold">Braavolabs</span>
          </Link>
        </div>

        {/* Done step */}
        <div className="flex-1 flex items-center justify-center px-5 py-8">
          <div className="bv-glass bv-rise w-full max-w-[520px] p-8 text-center" style={{ border: "1px solid rgba(59,130,246,0.2)" }}>
            {/* Emblem with halo */}
            <div className="relative w-24 h-24 mx-auto mb-6">
              <div
                className="absolute inset-[-16%] rounded-full animate-pulse-glow"
                style={{ background: "radial-gradient(circle, rgba(59,130,246,0.4), transparent 65%)", filter: "blur(12px)" }}
              />
              <div className="relative z-10 w-full h-full rounded-2xl flex items-center justify-center bv-avatar bv-avatar-lg">
                <span className="material-symbols-outlined text-4xl" style={{ color: "#fff" }}>check_circle</span>
              </div>
            </div>

            <p className="bv-micro mb-2" style={{ color: "var(--bv-cobalt-glow)", letterSpacing: "0.12em" }}>workspace forged</p>
            <h1 className="bv-display mb-3" style={{ fontSize: "clamp(26px,3.8vw,40px)", textTransform: "uppercase", letterSpacing: "-0.02em" }}>
              {result?.company?.name ?? t("app.onboarding.successCompanyFallback")}{t("app.onboarding.successLiveSuffix")}
            </h1>
            <p className="bv-body mb-6" style={{ color: "var(--color-on-surface-variant)", maxWidth: "38ch", margin: "0 auto 24px" }}>
              {result?.fromBlueprint
                ? t("app.onboarding.successFromBlueprint")
                : (result?.company?.description ?? t("app.onboarding.successDefault"))}
            </p>

            {result && !result.fromBlueprint && (
              <div className="flex justify-center gap-10 mb-6">
                <div>
                  <p className="bv-numeric text-2xl" style={{ color: "var(--bv-cobalt-glow)" }}>{result.agents?.length ?? 0}</p>
                  <p className="bv-caption">{t("app.onboarding.agents")}</p>
                </div>
                <div>
                  <p className="bv-numeric text-2xl" style={{ color: "var(--color-primary)" }}>1</p>
                  <p className="bv-caption">{t("app.onboarding.pipeline")}</p>
                </div>
              </div>
            )}

            {aiKeyConfigured === false && (
              <div className="mb-6 px-4 py-3 rounded-xl text-left" style={{ background: "rgba(255,122,26,0.08)", border: "1px solid rgba(255,122,26,0.25)" }}>
                <div className="flex items-start gap-2">
                  <span className="material-symbols-outlined text-base mt-0.5" style={{ color: "var(--bv-status-running)" }}>key</span>
                  <div className="flex-1">
                    <p className="bv-title text-sm mb-1" style={{ color: "#FFA64D" }}>{t("app.onboarding.byokTitle")}</p>
                    <p className="bv-caption mb-3" style={{ color: "var(--bv-status-running)" }}>{t("app.onboarding.byokSubtitle")}</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
                      <Link
                        href="/settings#ai-provider"
                        className="flex flex-col gap-1 p-2.5 rounded-lg text-left transition-all hover:brightness-125"
                        style={{ background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.25)" }}
                      >
                        <span className="text-[11px] font-bold" style={{ color: "var(--bv-cobalt-glow)" }}>{t("app.onboarding.byokCloudTitle")}</span>
                        <span className="text-[10px]" style={{ color: "var(--color-on-surface-variant)" }}>{t("app.onboarding.byokCloudDesc")}</span>
                      </Link>
                      <Link
                        href="/settings#ai-provider"
                        className="flex flex-col gap-1 p-2.5 rounded-lg text-left transition-all hover:brightness-125"
                        style={{ background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.25)" }}
                      >
                        <span className="text-[11px] font-bold" style={{ color: "var(--color-primary)" }}>{t("app.onboarding.byokSelfTitle")}</span>
                        <span className="text-[10px]" style={{ color: "var(--color-on-surface-variant)" }}>{t("app.onboarding.byokSelfDesc")}</span>
                      </Link>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="flex gap-3 justify-center">
              <Link
                href={aiKeyConfigured === false ? "/settings#ai-provider" : "/companies"}
                className="bv-btn bv-btn-primary bv-sheen"
              >
                {aiKeyConfigured === false ? t("app.onboarding.addApiKey") : t("app.onboarding.viewCompanies")}
                <span className="material-symbols-outlined text-base">arrow_forward</span>
              </Link>
              <Link href="/dashboard" className="bv-btn bv-btn-ghost">
                {t("app.onboarding.dashboard")}
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bv-mesh min-h-screen flex flex-col" style={{ height: "100vh", overflow: "hidden" }}>
      {/* Arc progress bar */}
      <div className="h-[3px] flex-none" style={{ background: "var(--bv-steel-shadow)" }}>
        <div
          className="h-full transition-all duration-700"
          style={{
            width: `${barWidth}%`,
            background: "linear-gradient(90deg, var(--bv-cobalt-glow), var(--bv-cobalt-deep))",
            boxShadow: "0 0 14px var(--bv-cobalt-glow)",
          }}
        />
      </div>

      {/* Top bar */}
      <div className="flex items-center px-7 py-5 flex-none">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="bv-avatar w-8 h-8 rounded-lg text-xs font-bold">AI</div>
          <span className="bv-title text-sm font-semibold">Braavolabs</span>
        </Link>
        <Link href="/dashboard" className="ml-auto bv-mono text-xs" style={{ color: "var(--color-on-surface-variant)" }}>
          Skip setup →
        </Link>
      </div>

      {/* Stage */}
      <div className="flex-1 flex items-center justify-center px-5 overflow-hidden relative">
        {/* Step 0: Industry & Use Case Selection */}
        {step === 0 && (
          <div className="bv-rise w-full max-w-[640px] text-center">
            {/* Emblem */}
            <div className="relative w-[100px] h-[100px] mx-auto mb-6">
              <div
                className="absolute inset-[-16%] rounded-full"
                style={{ background: "radial-gradient(circle, rgba(59,130,246,0.4), transparent 65%)", filter: "blur(12px)", animation: "bv-pulse-glow 5s ease-in-out infinite" }}
              />
              <div className="relative z-10 w-full h-full bv-avatar bv-avatar-lg rounded-full flex items-center justify-center">
                <span className="material-symbols-outlined text-3xl text-white">rocket_launch</span>
              </div>
            </div>

            <p className="bv-micro mb-2" style={{ color: "var(--bv-cobalt-glow)", letterSpacing: "0.12em" }}>step 1 of {TOTAL_STEPS}</p>
            <h1
              className="font-headline font-semibold mb-3"
              style={{ fontSize: "clamp(28px,4vw,48px)", textTransform: "uppercase", letterSpacing: "-0.02em", lineHeight: 1 }}
            >
              {t("app.onboarding.step0Title")}
            </h1>
            <p className="bv-body mb-8" style={{ color: "var(--color-on-surface-variant)", maxWidth: "44ch", margin: "0 auto 32px" }}>
              {t("app.onboarding.step0Subtitle")}
            </p>

            {/* Industry grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-6 text-left">
              {INDUSTRIES.map((ind) => {
                const selected = selectedIndustry === ind.id;
                return (
                  <button
                    key={ind.id}
                    onClick={() => setSelectedIndustry(ind.id)}
                    className="bv-glass p-3 text-left transition-all hover:scale-[1.02] cursor-pointer"
                    style={{
                      border: selected ? "1.5px solid rgba(59,130,246,0.5)" : "1px solid var(--bv-glass-border)",
                      boxShadow: selected ? "0 0 0 1px rgba(59,130,246,0.2)" : "none",
                      borderRadius: "14px",
                    }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="material-symbols-outlined text-base" style={{ color: selected ? "var(--bv-cobalt-glow)" : "var(--color-on-surface-variant)" }}>
                        {ind.icon}
                      </span>
                      <span className="bv-body font-semibold text-xs" style={{ color: selected ? "var(--color-on-surface)" : "var(--color-on-surface-variant)" }}>
                        {t(`app.onboarding.industries.${ind.id}.label`)}
                      </span>
                    </div>
                    <p className="text-[10px]" style={{ color: "var(--bv-text-faint)" }}>{t(`app.onboarding.industries.${ind.id}.desc`)}</p>
                  </button>
                );
              })}
            </div>

            {/* Use case selection */}
            <div className="mb-6 text-left">
              <p className="bv-micro mb-2">
                {t("app.onboarding.automateQuestion")}{" "}
                <span style={{ color: "var(--bv-text-faint)", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>{t("app.onboarding.automateHint")}</span>
              </p>
              <div className="flex flex-wrap gap-2">
                {USE_CASES.map((uc) => {
                  const selected = selectedUseCases.includes(uc);
                  return (
                    <button
                      key={uc}
                      onClick={() => toggleUseCase(uc)}
                      className={`bv-fpill${selected ? " active" : ""}`}
                    >
                      {uc}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Suggested blueprints */}
            {selectedIndustry && (
              <div className="mb-6 text-left">
                <p className="bv-micro mb-2">
                  {t("app.onboarding.recommendedBlueprints")}
                  <span className="ml-1" style={{ color: "var(--bv-text-faint)", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>{t("app.onboarding.blueprintsHint")}</span>
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
                          className="bv-glass w-full p-3 text-left transition-all hover:brightness-110 cursor-pointer"
                          style={{
                            border: isSelected ? "1.5px solid rgba(59,130,246,0.4)" : "1px solid var(--bv-glass-border)",
                            borderRadius: "14px",
                          }}
                        >
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-0.5">
                                <span className="text-xs font-semibold" style={{ color: isSelected ? "var(--bv-cobalt-glow)" : "var(--color-on-surface)" }}>{bp.title}</span>
                                {isSelected && (
                                  <span className="bv-pill bv-pill-cyan">{t("app.onboarding.blueprintSelectedBadge")}</span>
                                )}
                              </div>
                              <p className="text-[10px] line-clamp-1" style={{ color: "var(--color-on-surface-variant)" }}>{bp.description}</p>
                            </div>
                            <div className="flex items-center gap-2 ml-3 shrink-0">
                              <span className="bv-mono" style={{ color: "var(--bv-text-faint)" }}>{bp.agentCount}a · {bp.pipelineCount}p</span>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="bv-caption" style={{ color: "var(--bv-text-faint)" }}>{t("app.onboarding.noBlueprints")}</p>
                )}
              </div>
            )}

            <div className="flex justify-between items-center pt-4">
              <p className="bv-caption" style={{ color: "var(--bv-text-faint)" }}>
                {!selectedIndustry && t("app.onboarding.selectIndustryHint")}
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setStep(1)}
                  disabled={!selectedIndustry}
                  className="bv-btn bv-btn-primary bv-sheen disabled:opacity-40"
                >
                  {t("app.onboarding.continueButton")}
                  <span className="material-symbols-outlined text-base">arrow_forward</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Step 1: Company description */}
        {step === 1 && (
          <div className="bv-rise w-full max-w-[640px] text-center">
            <p className="bv-micro mb-2" style={{ color: "var(--bv-cobalt-glow)", letterSpacing: "0.12em" }}>step 2 of {TOTAL_STEPS}</p>
            <h1
              className="font-headline font-semibold mb-3"
              style={{ fontSize: "clamp(28px,4vw,48px)", textTransform: "uppercase", letterSpacing: "-0.02em", lineHeight: 1 }}
            >
              {t("app.onboarding.step1Title")}
            </h1>
            <p className="bv-body mb-8" style={{ color: "var(--color-on-surface-variant)", maxWidth: "44ch", margin: "0 auto 32px" }}>
              {t("app.onboarding.step1Subtitle")}
            </p>

            <div className="mb-4 text-left">
              <label className="bv-micro block mb-1.5">{t("app.onboarding.fieldCompanyName")}</label>
              <input
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="w-full px-4 py-3 rounded-xl text-sm outline-none transition-all mb-4"
                style={{
                  background: "var(--color-surface-container-low)",
                  border: "1px solid var(--bv-steel-shadow)",
                  color: "var(--color-on-surface)",
                  fontFamily: "var(--bv-font-body)",
                }}
                onFocus={(e) => { e.currentTarget.style.border = "1px solid rgba(59,130,246,0.5)"; e.currentTarget.style.boxShadow = "0 0 0 3px rgba(59,130,246,0.12)"; }}
                onBlur={(e) => { e.currentTarget.style.border = "1px solid var(--bv-steel-shadow)"; e.currentTarget.style.boxShadow = "none"; }}
                placeholder={t("app.onboarding.companyNamePlaceholder")}
              />
              <label className="bv-micro block mb-1.5">{t("app.onboarding.fieldDescribeBusiness")}</label>
              <div className="relative">
                <textarea
                  rows={5}
                  value={description}
                  onChange={(e) => { setDescription(e.target.value); setDescError(null); }}
                  className="w-full px-4 py-3 rounded-xl text-sm outline-none resize-none transition-all"
                  style={{
                    background: "var(--color-surface-container-low)",
                    border: "1px solid var(--bv-steel-shadow)",
                    color: "var(--color-on-surface)",
                    lineHeight: 1.7,
                    fontFamily: "var(--bv-font-body)",
                    height: "120px",
                  }}
                  placeholder={t("app.onboarding.descriptionPlaceholder")}
                  onFocus={(e) => { e.currentTarget.style.border = "1px solid rgba(59,130,246,0.5)"; e.currentTarget.style.boxShadow = "0 0 0 3px rgba(59,130,246,0.12)"; }}
                  onBlur={(e) => { e.currentTarget.style.border = "1px solid var(--bv-steel-shadow)"; e.currentTarget.style.boxShadow = "none"; }}
                />
                <span className="absolute bottom-2 right-3 bv-mono" style={{ color: "var(--bv-text-faint)" }}>{description.length} / 500</span>
              </div>
              {descError && (
                <p className="mt-1.5 text-xs" style={{ color: "var(--color-error)" }}>{descError}</p>
              )}
            </div>

            {/* Suggestions */}
            {!selectedBlueprintSlug && (
              <div className="mb-6 text-left">
                <p className="bv-caption mb-2">{t("app.onboarding.needInspiration")}</p>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => setDescription(t("app.onboarding.suggestionTemplate", { kind: s.toLowerCase() }))}
                      className="bv-fpill"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {selectedBlueprintSlug && (
              <div className="mb-6 px-4 py-3 rounded-xl text-left" style={{ background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.15)" }}>
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-sm" style={{ color: "var(--bv-cobalt-glow)" }}>auto_awesome</span>
                  <span className="bv-caption" style={{ color: "var(--color-primary-fixed)" }}>{t("app.onboarding.blueprintSelected")}</span>
                  <button onClick={() => setSelectedBlueprintSlug(null)} className="ml-auto bv-caption" style={{ color: "var(--bv-text-faint)" }}>{t("app.onboarding.removeBlueprint")}</button>
                </div>
              </div>
            )}

            {descTouched && !description.trim() && !selectedBlueprintSlug && (
              <p className="text-xs mb-3" style={{ color: "var(--color-error)" }}>{t("app.onboarding.describeOrSelectError")}</p>
            )}

            <div className="flex justify-between">
              <button onClick={() => setStep(0)} className="bv-btn bv-btn-ghost">
                <span className="material-symbols-outlined text-base">arrow_back</span>
                {t("app.onboarding.backButton")}
              </button>
              <button
                onClick={() => {
                  setDescTouched(true);
                  if (!description.trim() && !selectedBlueprintSlug) { setDescError(t("app.onboarding.describeError")); return; }
                  setDescError(null);
                  setStep(2);
                }}
                className="bv-btn bv-btn-primary bv-sheen"
              >
                {t("app.onboarding.continueButton")}
                <span className="material-symbols-outlined text-base">arrow_forward</span>
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Primitives */}
        {step === 2 && (
          <div className="bv-rise w-full max-w-[640px] text-center">
            <p className="bv-micro mb-2" style={{ color: "var(--bv-cobalt-glow)", letterSpacing: "0.12em" }}>step 3 of {TOTAL_STEPS}</p>
            <h1
              className="font-headline font-semibold mb-3"
              style={{ fontSize: "clamp(28px,4vw,48px)", textTransform: "uppercase", letterSpacing: "-0.02em", lineHeight: 1 }}
            >
              {t("app.onboarding.step2Title")}
            </h1>
            <p className="bv-body mb-8" style={{ color: "var(--color-on-surface-variant)", maxWidth: "44ch", margin: "0 auto 32px" }}>
              {selectedBlueprintSlug
                ? t("app.onboarding.step2SubtitleBlueprint")
                : t("app.onboarding.step2SubtitleDefault")}
            </p>

            <div className="grid grid-cols-3 gap-3 mb-6">
              {PRIMITIVES.map((p) => {
                const selected = selectedPrimitives.includes(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => togglePrimitive(p.id)}
                    className="bv-glass p-4 text-left transition-all hover:scale-[1.02] cursor-pointer"
                    style={{
                      border: selected ? "1.5px solid rgba(59,130,246,0.5)" : "1px solid var(--bv-glass-border)",
                      boxShadow: selected ? "0 0 0 1px rgba(59,130,246,0.2)" : "none",
                      borderRadius: "14px",
                    }}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span
                        className="material-symbols-outlined text-lg"
                        style={{ color: selected ? "var(--bv-cobalt-glow)" : "var(--color-on-surface-variant)" }}
                      >
                        {p.icon}
                      </span>
                    </div>
                    <p className="text-sm font-semibold" style={{ color: selected ? "var(--color-on-surface)" : "var(--color-on-surface-variant)" }}>
                      {t(`app.onboarding.primitives.${p.id}.label`)}
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: "var(--color-on-surface-variant)" }}>
                      {t(`app.onboarding.primitives.${p.id}.desc`)}
                    </p>
                  </button>
                );
              })}
            </div>

            <div className="flex justify-between">
              <button onClick={() => setStep(1)} className="bv-btn bv-btn-ghost">
                <span className="material-symbols-outlined text-base">arrow_back</span>
                {t("app.onboarding.backButton")}
              </button>
              <button onClick={() => setStep(3)} className="bv-btn bv-btn-primary bv-sheen">
                {t("app.onboarding.continueButton")}
                <span className="material-symbols-outlined text-base">arrow_forward</span>
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Channels */}
        {step === 3 && (
          <div className="bv-rise w-full max-w-[640px] text-center">
            <p className="bv-micro mb-2" style={{ color: "var(--bv-cobalt-glow)", letterSpacing: "0.12em" }}>step 4 of {TOTAL_STEPS}</p>
            <h1
              className="font-headline font-semibold mb-3"
              style={{ fontSize: "clamp(28px,4vw,48px)", textTransform: "uppercase", letterSpacing: "-0.02em", lineHeight: 1 }}
            >
              {t("app.onboarding.step3Title")}
            </h1>
            <p className="bv-body mb-8" style={{ color: "var(--color-on-surface-variant)", maxWidth: "44ch", margin: "0 auto 32px" }}>
              {t("app.onboarding.step3Subtitle")}
            </p>

            <div className="space-y-4 mb-6 text-left">
              <div>
                <label className="bv-micro block mb-1.5">
                  {t("app.onboarding.fieldNiche")}{" "}
                  <span style={{ color: "var(--bv-text-faint)", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>{t("app.onboarding.optional")}</span>
                </label>
                <input
                  type="text"
                  value={niche}
                  onChange={(e) => setNiche(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl text-sm outline-none transition-all"
                  style={{
                    background: "var(--color-surface-container-low)",
                    border: "1px solid var(--bv-steel-shadow)",
                    color: "var(--color-on-surface)",
                    fontFamily: "var(--bv-font-body)",
                  }}
                  placeholder={t("app.onboarding.nichePlaceholder")}
                  onFocus={(e) => { e.currentTarget.style.border = "1px solid rgba(59,130,246,0.5)"; e.currentTarget.style.boxShadow = "0 0 0 3px rgba(59,130,246,0.12)"; }}
                  onBlur={(e) => { e.currentTarget.style.border = "1px solid var(--bv-steel-shadow)"; e.currentTarget.style.boxShadow = "none"; }}
                />
              </div>
              <div>
                <label className="bv-micro block mb-1.5">
                  {t("app.onboarding.fieldTargetAudience")}{" "}
                  <span style={{ color: "var(--bv-text-faint)", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>{t("app.onboarding.optional")}</span>
                </label>
                <input
                  type="text"
                  value={targetAudience}
                  onChange={(e) => setTargetAudience(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl text-sm outline-none transition-all"
                  style={{
                    background: "var(--color-surface-container-low)",
                    border: "1px solid var(--bv-steel-shadow)",
                    color: "var(--color-on-surface)",
                    fontFamily: "var(--bv-font-body)",
                  }}
                  placeholder={t("app.onboarding.audiencePlaceholder")}
                  onFocus={(e) => { e.currentTarget.style.border = "1px solid rgba(59,130,246,0.5)"; e.currentTarget.style.boxShadow = "0 0 0 3px rgba(59,130,246,0.12)"; }}
                  onBlur={(e) => { e.currentTarget.style.border = "1px solid var(--bv-steel-shadow)"; e.currentTarget.style.boxShadow = "none"; }}
                />
              </div>

              {/* Active channels */}
              <div>
                <label className="bv-micro block mb-2">{t("app.onboarding.activeChannelsTitle")}</label>
                <div className="flex flex-wrap gap-3">
                  {[
                    { name: "TikTok", icon: "🎵", included: true },
                    { name: "LinkedIn", icon: "💼", included: true },
                    { name: "Twitter/X", icon: "𝕏", included: false },
                    { name: "Instagram", icon: "📸", included: false },
                  ].map((ch) => (
                    <div
                      key={ch.name}
                      className="flex items-center gap-2 px-3 py-2 rounded-xl flex-shrink-0"
                      style={{
                        background: ch.included ? "rgba(59,130,246,0.08)" : "rgba(255,255,255,0.03)",
                        border: `1.5px solid ${ch.included ? "rgba(59,130,246,0.3)" : "rgba(255,255,255,0.05)"}`,
                        opacity: ch.included ? 1 : 0.5,
                      }}
                    >
                      <span className="text-sm">{ch.icon}</span>
                      <span className="bv-caption" style={{ color: ch.included ? "var(--color-on-surface-variant)" : "var(--bv-text-faint)" }}>{ch.name}</span>
                      {ch.included && <span className="material-symbols-outlined text-xs" style={{ color: "var(--bv-cobalt-glow)", fontSize: "14px" }}>check</span>}
                    </div>
                  ))}
                </div>
                <p className="bv-caption mt-2" style={{ color: "var(--bv-text-faint)" }}>{t("app.onboarding.upgradeToProForChannels")}</p>
              </div>
            </div>

            <div className="flex justify-between">
              <button onClick={() => setStep(2)} className="bv-btn bv-btn-ghost">
                <span className="material-symbols-outlined text-base">arrow_back</span>
                {t("app.onboarding.backButton")}
              </button>
              <button onClick={() => setStep(4)} className="bv-btn bv-btn-primary bv-sheen">
                {t("app.onboarding.continueButton")}
                <span className="material-symbols-outlined text-base">arrow_forward</span>
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Launch */}
        {step === 4 && (
          <div className="bv-rise w-full max-w-[640px] text-center">
            <p className="bv-micro mb-2" style={{ color: "var(--bv-cobalt-glow)", letterSpacing: "0.12em" }}>step 5 of {TOTAL_STEPS}</p>
            <h1
              className="font-headline font-semibold mb-3"
              style={{ fontSize: "clamp(28px,4vw,48px)", textTransform: "uppercase", letterSpacing: "-0.02em", lineHeight: 1 }}
            >
              {t("app.onboarding.step4Title")}
            </h1>
            <p className="bv-body mb-8" style={{ color: "var(--color-on-surface-variant)", maxWidth: "44ch", margin: "0 auto 32px" }}>
              {t("app.onboarding.step4Subtitle")}
            </p>

            {/* Summary */}
            <div className="bv-glass rounded-xl p-5 mb-5 space-y-3 text-left" style={{ borderRadius: "14px" }}>
              <SummaryRow label={t("app.onboarding.summaryCompanyName")} value={companyName || t("app.onboarding.companyNamePlaceholder")} />
              <SummaryRow label={t("app.onboarding.summaryIndustry")} value={selectedIndustry ? t(`app.onboarding.industries.${selectedIndustry}.label`) : "—"} />
              {selectedBlueprintSlug && (
                <SummaryRow label={t("app.onboarding.summaryBlueprint")} value={suggestedBlueprints.find((b) => b.slug === selectedBlueprintSlug)?.title ?? selectedBlueprintSlug} highlight />
              )}
              <SummaryRow label={t("app.onboarding.summaryPrimitives")} value={t("app.onboarding.summaryPrimitivesValueTemplate", { count: selectedPrimitives.length })} highlight />
              <SummaryRow label={t("app.onboarding.summaryChannels")} value="TikTok, LinkedIn" />
              {niche && <SummaryRow label={t("app.onboarding.summaryNiche")} value={niche} />}
              {targetAudience && <SummaryRow label={t("app.onboarding.summaryAudience")} value={targetAudience} />}
            </div>

            {error && (
              <div className="mb-4 px-4 py-3 rounded-xl bv-body" style={{ background: "rgba(255,77,77,0.08)", border: "1px solid rgba(255,77,77,0.2)", color: "var(--color-error)" }}>
                {error}
              </div>
            )}

            <div className="flex justify-between">
              <button onClick={() => setStep(3)} className="bv-btn bv-btn-ghost">
                <span className="material-symbols-outlined text-base">arrow_back</span>
                {t("app.onboarding.backButton")}
              </button>
              <button
                onClick={handleLaunch}
                disabled={loading}
                className="bv-btn bv-btn-primary bv-sheen disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <span className="w-4 h-4 border-2 rounded-full animate-spin inline-block" style={{ borderColor: "rgba(255,255,255,0.3)", borderTopColor: "#fff" }} />
                    {t("app.onboarding.creatingButton")}
                  </>
                ) : (
                  <>
                    {t("app.onboarding.launchButton")}
                    <span className="material-symbols-outlined text-base">rocket_launch</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Onboarding progress bar (if server status exists) */}
      {status && (
        <div className="flex-none px-7 pb-5">
          <div className="bv-glass rounded-xl p-4 flex items-center gap-4 max-w-[640px] mx-auto" style={{ borderRadius: "14px" }}>
            <div className="flex-1">
              <div className="flex justify-between mb-1">
                <span className="bv-caption">{t("app.onboarding.onboardingProgress")}</span>
                <span className="bv-mono" style={{ color: "var(--bv-cobalt-glow)" }}>{progressPct}%</span>
              </div>
              <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--bv-steel-shadow)" }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${progressPct}%`, background: "linear-gradient(90deg, var(--bv-cobalt-glow), var(--bv-cobalt-deep))" }}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex justify-between items-center">
      <span className="bv-caption">{label}</span>
      <span className="bv-body font-semibold" style={{ color: highlight ? "var(--bv-cobalt-glow)" : "var(--color-on-surface-variant)" }}>{value}</span>
    </div>
  );
}

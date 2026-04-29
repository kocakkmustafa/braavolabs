"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";

interface OnboardingStatus {
  completed: boolean;
  progress: number;
  steps: Record<string, boolean>;
}

const PRIMITIVES = [
  { id: "acquisition", label: "Acquisition", icon: "podcasts", desc: "Lead gen & growth" },
  { id: "sales", label: "Sales", icon: "work", desc: "Pipeline & deals" },
  { id: "delivery", label: "Delivery", icon: "deployed_code", desc: "Fulfillment ops" },
  { id: "content", label: "Content", icon: "edit_note", desc: "AI-generated content" },
  { id: "operations", label: "Operations", icon: "account_tree", desc: "Internal workflows" },
  { id: "finance", label: "Finance", icon: "payments", desc: "Revenue & billing" },
  { id: "analytics", label: "Analytics", icon: "query_stats", desc: "Insights & reports" },
  { id: "memory", label: "Memory", icon: "memory", desc: "Agent learning" },
  { id: "governance", label: "Governance", icon: "security", desc: "Risk & compliance" },
];

const INDUSTRIES = [
  { id: "saas", label: "SaaS / Software", icon: "cloud", desc: "Subscription & product-led growth" },
  { id: "agency", label: "Agency", icon: "business_center", desc: "Client services & delivery" },
  { id: "ecommerce", label: "E-Commerce", icon: "shopping_bag", desc: "Online store & DTC" },
  { id: "consulting", label: "Consulting", icon: "handshake", desc: "Professional services" },
  { id: "creator", label: "Creator / Personal Brand", icon: "person_celebrate", desc: "Content & audience building" },
  { id: "b2b_sales", label: "B2B Sales", icon: "sales", desc: "Lead gen & outreach" },
  { id: "real_estate", label: "Real Estate", icon: "home_work", desc: "Listings & client management" },
  { id: "marketing", label: "Marketing Agency", icon: "campaign", desc: "Digital marketing & ads" },
  { id: "automation", label: "AI / Automation", icon: "smart_toy", desc: "Workflow automation services" },
  { id: "support", label: "Customer Support", icon: "support_agent", desc: "Helpdesk & ticketing" },
];

const USE_CASES = [
  "Scale content production",
  "Automate lead generation",
  "Manage customer relationships",
  "Build revenue systems",
  "Reduce operational overhead",
  "Grow social media presence",
  "Improve customer support speed",
  "Automate financial reporting",
];

const STEP_LABELS = ["Industry", "Company", "Primitives", "Channels", "Launch"];
const SUGGESTIONS = ["SaaS Startup", "Agency", "E-commerce", "Consulting", "Creator Business"];

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
  const router = useRouter();
  const { token, hydrated } = useAuthGuard();
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [step, setStep] = useState(0);
  const [description, setDescription] = useState("");
  const [selectedPrimitives, setSelectedPrimitives] = useState<string[]>(["content", "acquisition"]);
  const [companyName, setCompanyName] = useState("My AI Social Agency");
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

  // When industry is selected, fetch suggested blueprints
  useEffect(() => {
    if (!selectedIndustry || !token) return;
    setLoadingBlueprints(true);
    setSuggestedBlueprints([]);
    setSelectedBlueprintSlug(null);
    api.listCatalogBlueprints(token, selectedIndustry)
      .then((list) => setSuggestedBlueprints(list.slice(0, 3)))
      .catch(() => setSuggestedBlueprints([]))
      .finally(() => setLoadingBlueprints(false));
  }, [selectedIndustry, token]);

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
      // If a blueprint was selected, clone it instead of creating hero company
      if (selectedBlueprintSlug) {
        const res = await api.cloneCatalogBlueprint(token!, selectedBlueprintSlug, companyName);
        setResult({ company: res.company, agents: [], fromBlueprint: true });
      } else {
        const res = await api.createHeroCompany(token!, {
          companyName: companyName.trim() || undefined,
          niche: niche.trim() || undefined,
          targetAudience: targetAudience.trim() || undefined,
        });
        setResult(res);
      }
      // Wizard complete — clear the saved draft so a future visit doesn't
      // restore a stale snapshot.
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
            {result?.company?.name ?? "Your Company"} is live!
          </h2>
          <p className="text-sm mb-6" style={{ color: "#859399" }}>
            {result?.fromBlueprint
              ? "Blueprint cloned and configured. Your autonomous AI company is ready."
              : (result?.company?.description ?? "Your autonomous AI company is ready to run.")}
          </p>
          {result && !result.fromBlueprint && (
            <div className="flex justify-center gap-8 mb-6">
              <div>
                <p className="text-2xl font-bold font-headline" style={{ color: "#34d399" }}>
                  {result.agents?.length ?? 0}
                </p>
                <p className="text-xs" style={{ color: "#859399" }}>Agents</p>
              </div>
              <div>
                <p className="text-2xl font-bold font-headline" style={{ color: "#00d1ff" }}>1</p>
                <p className="text-xs" style={{ color: "#859399" }}>Pipeline</p>
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
                    One last step — pick how your agents access an LLM
                  </p>
                  <p className="text-xs leading-relaxed mb-3" style={{ color: "#f59e0b" }}>
                    You have two options. Both keep your data tenant-isolated and audit-logged.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
                    <Link
                      href="/settings#ai-provider"
                      className="flex flex-col gap-1 p-2.5 rounded-lg text-left transition-all hover:brightness-125"
                      style={{ background: "rgba(0,209,255,0.08)", border: "1px solid rgba(0,209,255,0.25)" }}
                    >
                      <span className="text-[11px] font-bold" style={{ color: "#00d1ff" }}>☁ Cloud BYOK (any plan)</span>
                      <span className="text-[10px]" style={{ color: "#859399" }}>Anthropic, OpenAI, Gemini, Mistral, Groq, OpenRouter</span>
                    </Link>
                    <Link
                      href="/settings#ai-provider"
                      className="flex flex-col gap-1 p-2.5 rounded-lg text-left transition-all hover:brightness-125"
                      style={{ background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.25)" }}
                    >
                      <span className="text-[11px] font-bold" style={{ color: "#34d399" }}>⚡ Self-hosted Gemma (Creator+)</span>
                      <span className="text-[10px]" style={{ color: "#859399" }}>Ollama / LM Studio · no per-token cost · KVKK</span>
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
              {aiKeyConfigured === false ? "Add API Key" : "View Companies"}
            </Link>
            <Link
              href="/dashboard"
              className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-80"
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}
            >
              Dashboard
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
              <div key={label} className="flex items-center gap-2">
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
                What's your industry?
              </h2>
              <p className="text-sm mb-6" style={{ color: "#859399" }}>
                We'll suggest the best blueprint for your business so you can launch faster.
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
                        <span className="text-xs font-semibold" style={{ color: selected ? "#e1e2eb" : "#bbc9cf" }}>{ind.label}</span>
                      </div>
                      <p className="text-[10px]" style={{ color: "#3c494e" }}>{ind.desc}</p>
                    </button>
                  );
                })}
              </div>

              {/* Use case selection */}
              <div className="mb-6">
                <p className="text-xs font-semibold mb-2" style={{ color: "#bbc9cf" }}>What do you want to automate? <span style={{ color: "#3c494e", fontWeight: 400 }}>(pick all that apply)</span></p>
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
                    Recommended blueprints
                    <span className="ml-1 font-normal" style={{ color: "#3c494e" }}>— click to use as starting point</span>
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
                                    <span className="text-[10px] px-1.5 py-0.5 rounded font-bold" style={{ background: "rgba(0,209,255,0.15)", color: "#00d1ff" }}>SELECTED</span>
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
                    <p className="text-xs" style={{ color: "#3c494e" }}>No templates found for this industry.</p>
                  )}
                </div>
              )}

              <div className="flex justify-between items-center sticky bottom-0 pt-4 pb-1 -mb-4 z-10" style={{ background: "linear-gradient(to top, rgba(15,18,25,1) 60%, rgba(15,18,25,0))" }}>
                <p className="text-xs" style={{ color: "#3c494e" }}>
                  {!selectedIndustry && "Select an industry to continue"}
                </p>
                <button
                  onClick={() => setStep(1)}
                  disabled={!selectedIndustry}
                  className="px-6 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-40"
                  style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", boxShadow: "0 0 20px rgba(0,209,255,0.2)" }}
                >
                  Continue →
                </button>
              </div>
            </div>
          )}

          {/* Step 1: Company description */}
          {step === 1 && (
            <div>
              <h2 className="font-headline font-bold text-2xl mb-2" style={{ color: "#e1e2eb" }}>
                Tell us about your company
              </h2>
              <p className="text-sm mb-6" style={{ color: "#859399" }}>
                Write in plain language — Claude will understand and build your agent stack automatically.
              </p>

              <div className="mb-4">
                <label className="block text-xs font-semibold mb-1.5" style={{ color: "#bbc9cf" }}>Company Name</label>
                <input
                  type="text"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl text-sm outline-none transition-all mb-4"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }}
                  placeholder="My AI Social Agency"
                />
                <label className="block text-xs font-semibold mb-1.5" style={{ color: "#bbc9cf" }}>Describe your business</label>
                <div className="relative">
                  <textarea
                    rows={5}
                    value={description}
                    onChange={(e) => { setDescription(e.target.value); setDescError(null); }}
                    className="w-full px-4 py-3 rounded-xl text-sm outline-none resize-none transition-all"
                    style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb", lineHeight: 1.7 }}
                    placeholder="e.g. I run a social media management agency for e-commerce brands. I need content creation, client reporting, and lead generation..."
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
                  <p className="text-xs mb-2" style={{ color: "#859399" }}>Need inspiration?</p>
                  <div className="flex flex-wrap gap-2">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        onClick={() => setDescription(`I run a ${s.toLowerCase()} business. I need AI agents to handle acquisition, content creation, and operations.`)}
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
                    <span className="text-xs" style={{ color: "#a4e6ff" }}>Blueprint selected — primitives and agents pre-configured from template</span>
                    <button onClick={() => setSelectedBlueprintSlug(null)} className="ml-auto text-xs" style={{ color: "#3c494e" }}>× Remove</button>
                  </div>
                </div>
              )}

              {descTouched && !description.trim() && !selectedBlueprintSlug && (
                <p className="text-xs mb-3" style={{ color: "#f87171" }}>Please describe your business or select a blueprint above to continue.</p>
              )}

              <div className="flex justify-between">
                <button onClick={() => setStep(0)} className="px-5 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}>
                  ← Back
                </button>
                <button onClick={() => { setDescTouched(true); if (!description.trim() && !selectedBlueprintSlug) { setDescError("Please describe your business before continuing."); return; } setDescError(null); setStep(2); }} className="px-6 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90" style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", boxShadow: "0 0 20px rgba(0,209,255,0.2)" }}>
                  Continue →
                </button>
              </div>
            </div>
          )}

          {/* Step 2: Primitives */}
          {step === 2 && (
            <div>
              <h2 className="font-headline font-bold text-2xl mb-2" style={{ color: "#e1e2eb" }}>
                Select your AI Primitives
              </h2>
              <p className="text-sm mb-6" style={{ color: "#859399" }}>
                {selectedBlueprintSlug
                  ? "Pre-configured from your selected blueprint. You can customize further."
                  : "Choose which capabilities to include. You can change these later."}
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
                      <p className="text-sm font-semibold" style={{ color: selected ? "#e1e2eb" : "#bbc9cf" }}>{p.label}</p>
                      <p className="text-xs mt-0.5" style={{ color: "#859399" }}>{p.desc}</p>
                    </button>
                  );
                })}
              </div>

              <div className="flex justify-between">
                <button onClick={() => setStep(1)} className="px-5 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}>
                  ← Back
                </button>
                <button onClick={() => setStep(3)} className="px-6 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90" style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", boxShadow: "0 0 20px rgba(0,209,255,0.2)" }}>
                  Continue →
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Channels */}
          {step === 3 && (
            <div>
              <h2 className="font-headline font-bold text-2xl mb-2" style={{ color: "#e1e2eb" }}>
                Configure your channels
              </h2>
              <p className="text-sm mb-6" style={{ color: "#859399" }}>
                Define your target audience and niche to personalize your agent outputs.
              </p>

              <div className="space-y-4 mb-6">
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: "#bbc9cf" }}>Niche <span style={{ color: "#3c494e", fontWeight: 400 }}>(optional)</span></label>
                  <input
                    type="text"
                    value={niche}
                    onChange={(e) => setNiche(e.target.value)}
                    className="w-full px-4 py-2.5 rounded-xl text-sm outline-none transition-all"
                    style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }}
                    placeholder="e.g. B2B SaaS, fitness, e-commerce..."
                    onFocus={(e) => { e.currentTarget.style.border = "1px solid rgba(0,209,255,0.4)"; }}
                    onBlur={(e) => { e.currentTarget.style.border = "1px solid rgba(255,255,255,0.08)"; }}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: "#bbc9cf" }}>Target Audience <span style={{ color: "#3c494e", fontWeight: 400 }}>(optional)</span></label>
                  <input
                    type="text"
                    value={targetAudience}
                    onChange={(e) => setTargetAudience(e.target.value)}
                    className="w-full px-4 py-2.5 rounded-xl text-sm outline-none transition-all"
                    style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }}
                    placeholder="e.g. startup founders, marketers, developers..."
                    onFocus={(e) => { e.currentTarget.style.border = "1px solid rgba(0,209,255,0.4)"; }}
                    onBlur={(e) => { e.currentTarget.style.border = "1px solid rgba(255,255,255,0.08)"; }}
                  />
                </div>

                {/* Active channels */}
                <div>
                  <label className="block text-xs font-semibold mb-2" style={{ color: "#bbc9cf" }}>Active Channels (Free plan)</label>
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
                  <p className="text-xs mt-2" style={{ color: "#3c494e" }}>Upgrade to Pro for all channels</p>
                </div>
              </div>

              <div className="flex justify-between">
                <button onClick={() => setStep(2)} className="px-5 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}>
                  ← Back
                </button>
                <button onClick={() => setStep(4)} className="px-6 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90" style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", boxShadow: "0 0 20px rgba(0,209,255,0.2)" }}>
                  Continue →
                </button>
              </div>
            </div>
          )}

          {/* Step 4: Launch */}
          {step === 4 && (
            <div>
              <h2 className="font-headline font-bold text-2xl mb-2" style={{ color: "#e1e2eb" }}>
                Ready to launch
              </h2>
              <p className="text-sm mb-6" style={{ color: "#859399" }}>
                Review your configuration and create your first autonomous AI company.
              </p>

              {/* Summary */}
              <div className="rounded-xl p-5 mb-5 space-y-3" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <SummaryRow label="Company Name" value={companyName || "My AI Social Agency"} />
                <SummaryRow label="Industry" value={INDUSTRIES.find((i) => i.id === selectedIndustry)?.label ?? "-"} />
                {selectedBlueprintSlug && (
                  <SummaryRow label="Blueprint" value={suggestedBlueprints.find((b) => b.slug === selectedBlueprintSlug)?.title ?? selectedBlueprintSlug} highlight />
                )}
                <SummaryRow label="Primitives" value={`${selectedPrimitives.length} selected`} highlight />
                <SummaryRow label="Channels" value="TikTok, LinkedIn" />
                {niche && <SummaryRow label="Niche" value={niche} />}
                {targetAudience && <SummaryRow label="Audience" value={targetAudience} />}
              </div>

              {error && (
                <div className="mb-4 px-4 py-3 rounded-xl text-sm" style={{ background: "rgba(255,180,171,0.08)", border: "1px solid rgba(255,180,171,0.2)", color: "#ffb4ab" }}>
                  {error}
                </div>
              )}

              <div className="flex justify-between">
                <button onClick={() => setStep(3)} className="px-5 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}>
                  ← Back
                </button>
                <button
                  onClick={handleLaunch}
                  disabled={loading}
                  className="px-8 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-50"
                  style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", boxShadow: "0 0 24px rgba(0,209,255,0.3)" }}
                >
                  {loading ? "Creating company..." : "Launch Company ✨"}
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
                <span className="text-xs" style={{ color: "#859399" }}>Onboarding Progress</span>
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

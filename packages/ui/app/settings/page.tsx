"use client";
import { useLocalizedFailure } from "../../lib/localized-error";

import { useTranslations as useRuntimeTranslations } from "next-intl";

import { useLocale as useDisplayLocale } from "next-intl";
import { formatDateTime as formatDisplayDateTime, currentTimeZone as displayTimeZone } from "../../i18n/locales";

import { useTranslations as useLegacyTranslations } from "next-intl";


import { useEffect, useRef, useState, useId } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { api, apiFetch } from "../../lib/api";
import { useAppStore, captureAuthSession, isAuthSessionCurrent } from "../../lib/store";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { useToast } from "../../components/Toast";

interface BillingUsage {
  plan: string;
  period: { start: string; end: string };
  meters: { metric: string; value: number }[];
  live: { runs: number; toolCalls: number };
}

interface BillingSubscription {
  plan: string;
  stripeCustomerId: string | null;
  subscription: {
    id: string; status: string; currentPeriodEnd: string; cancelAtPeriodEnd: boolean;
  } | null;
}

// Pull plan limits from the shared 5-tier source of truth in @ai-company-os/core.
// Earlier this file hardcoded a stale 3-tier list (FREE / PRO $49 / ENTERPRISE)
// that disagreed with /pricing's 5-tier offer ($19 / $39 / $99). One import,
// one source, no drift.
import { PLAN_LIMITS as SHARED_PLAN_LIMITS, PLAN_PRICING, PLAN_LABEL, PLAN_ORDER } from "@ai-company-os/core";

const PLAN_LIMITS: Record<string, { runs: number; companies: number }> = Object.fromEntries(
  (Object.keys(SHARED_PLAN_LIMITS) as Array<keyof typeof SHARED_PLAN_LIMITS>).map((plan) => [
    plan,
    {
      runs: SHARED_PLAN_LIMITS[plan].maxRunsPerMonth,
      companies: SHARED_PLAN_LIMITS[plan].maxCompanies,
    },
  ])
);

// Stable id + i18n labelKey + icon. Labels resolve at render via
// useTranslations so a Turkish user sees "Profil" while routing keys
// stay debuggable.
const NAV_ITEMS = [
  { id: "profile",       labelKey: "navProfile",       icon: "person" },
  { id: "notifications", labelKey: "navNotifications", icon: "notifications" },
  { id: "billing",       labelKey: "navBilling",       icon: "credit_card" },
  { id: "ai_provider",   labelKey: "navAi",            icon: "smart_toy" },
  { id: "integrations",  labelKey: "navIntegrations",  icon: "hub" },
  { id: "governance",    labelKey: "navGovernance",    icon: "security" },
  { id: "api",           labelKey: "navApi",           icon: "terminal" },
  { id: "webhooks",      labelKey: "navWebhooks",      icon: "webhook" },
  { id: "referral",      labelKey: "navReferral",      icon: "redeem" },
];

// All 12 BYOK providers — mirrors AIProviderType in
// packages/api/src/services/ai-client.ts (same order). `models` here is the
// STATIC FALLBACK catalogue only: the live list comes from
// GET /api/v1/settings/ai-providers/:provider/models (JIT proxy, 5-min
// server cache) and this list is used when that endpoint is unavailable or
// the tenant has no key for the provider. Keep it in sync with
// PROVIDER_MODELS in ai-client.ts.
//
// Forge palette rule: NO GREEN anywhere (ok/success = arc-blue #3B82F6
// family). D-012: OPENAI/OLLAMA/LMSTUDIO chips used to be green/emerald
// (#10a37f/#34d399/#10b981) — remapped to the blue family below.
const RAW_PROVIDER_LABELS: Record<string, { label: string; color: string; models: string[]; local?: boolean; defaultBaseUrl?: string; setupHint?: string }> = {
  ANTHROPIC:  { label: "Anthropic Claude",   color: "#d97706", models: ["claude-opus-4-20250514", "claude-sonnet-4-5-20250929", "claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"] },
  OPENAI:     { label: "OpenAI",             color: "#38bdf8", models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o1", "o1-mini"] },
  GOOGLE:     { label: "Google Gemini",      color: "#4285f4", models: ["gemini-1.5-pro", "gemini-1.5-flash", "gemini-pro"] },
  MISTRAL:    { label: "Mistral AI",         color: "#ff6b35", models: ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest", "open-mistral-7b"] },
  GROQ:       { label: "Groq",               color: "#f97316", models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"] },
  OPENROUTER: { label: "OpenRouter",         color: "#8b5cf6", models: ["openai/gpt-4o", "anthropic/claude-sonnet-4-5", "meta-llama/llama-3.3-70b-instruct", "google/gemini-pro-1.5"] },
  DEEPSEEK:   { label: "DeepSeek",           color: "#4d6bfe", models: ["deepseek-chat", "deepseek-reasoner", "deepseek-coder"] },
  KIMI:       { label: "Kimi (Moonshot)",    color: "#6366f1", models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k", "moonshot-v1-auto"] },
  QWEN:       { label: "Qwen (DashScope)",   color: "#7c3aed", models: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen-long", "qwen2.5-72b-instruct", "qwen2.5-32b-instruct"] },
  // Cerebras + Zhipu GLM — OpenAI-compatible cloud, generous free tiers (Forge FAZ 1 / 1A)
  CEREBRAS:   { label: "Cerebras (free tier)", color: "#f59e0b", models: ["gpt-oss-120b", "glm-4.7"] },
  ZHIPU:      { label: "Zhipu GLM (free Flash)", color: "#818cf8", models: ["glm-4.7-flash", "glm-4.5-flash", "glm-4.6v-flash", "glm-4.7", "glm-4.6"] },
  // Self-hosted / local-first providers — runs on the user's own hardware
  // (laptop, on-prem server, private cloud). Tenant supplies a baseUrl
  // pointing at their own /v1/chat/completions endpoint. Plan-gated to
  // CREATOR and above (FREE plan keeps it simple with cloud-only BYOK).
  // setupHint is rendered in the settings UI for clarity.
  OLLAMA:     {
    label: "Ollama (self-hosted · Gemma 3)", color: "var(--color-primary)", local: true,
    defaultBaseUrl: "http://localhost:11434/v1",
    models: ["gemma3:4b", "gemma3:12b", "gemma3:27b", "llama3.2:3b", "llama3.3:70b", "qwen2.5:14b", "qwen2.5-coder:14b", "deepseek-r1:8b", "phi3:14b"],
    setupHint: "Install ollama.com → run `ollama pull gemma3:4b` → keep terminal open with `ollama serve`",
  },
  LMSTUDIO:   {
    label: "LM Studio (self-hosted)", color: "#2563eb", local: true,
    defaultBaseUrl: "http://localhost:1234/v1",
    models: ["google/gemma-3-4b-it", "google/gemma-3-12b-it", "meta-llama/llama-3.2-3b-instruct", "qwen/qwen2.5-14b-instruct"],
    setupHint: "Install lmstudio.ai → load Gemma 3 4B → start Local Server",
  },
  CUSTOM:     {
    label: "Custom OpenAI-compatible", color: "#a855f7", local: true,
    defaultBaseUrl: "",
    models: [],
    setupHint: "Any OpenAI-compatible /v1/chat/completions endpoint (LiteLLM, vLLM, Together, RunPod, etc).",
  },
};

// Plans that may configure self-hosted/local providers. FREE keeps it
// simple — cloud BYOK only. CREATOR+ unlocks self-hosted endpoints.
// Pulled into the AI Provider section so the disabled <option>s explain
// why and the upgrade CTA points to /pricing.
import { planAllowsLocalProvider } from "../../lib/plan-entitlements";

export default function SettingsPage() {
  const { token, hydrated } = useAuthGuard();
  const revision = useAppStore(state => state.sessionRevision);
  return hydrated && token ? <SettingsContent key={revision} /> : null;
}

function SettingsContent() {
  const describeFailure = useLocalizedFailure();
  const runtimeCopy = useRuntimeTranslations("runtime");
  const PROVIDER_LABELS = Object.fromEntries(Object.entries(RAW_PROVIDER_LABELS).map(([id, info]) => [id, {
    ...info,
    label: id === "CEREBRAS" ? "Cerebras" : id === "ZHIPU" ? "Zhipu GLM" : id === "OLLAMA" ? runtimeCopy("providerOllama") : id === "LMSTUDIO" ? runtimeCopy("providerLmStudio") : id === "CUSTOM" ? runtimeCopy("providerCustom") : info.label,
    setupHint: id === "OLLAMA" ? runtimeCopy("ollamaHint") : id === "LMSTUDIO" ? runtimeCopy("lmStudioHint") : id === "CUSTOM" ? runtimeCopy("customProviderHint") : undefined,
  }]));
  const displayLocale = useDisplayLocale();
  const uiText = useLegacyTranslations("uiCopy");
  const t = useTranslations();
  const router = useRouter();
  const { token, hydrated } = useAuthGuard();
  const tenantId = useAppStore((s) => s.tenantId);
  const { toast } = useToast();
  const owner = useRef(captureAuthSession());
  const mounted = useRef(true);
  const ownerAbort = useRef(new AbortController());
  const feedbackTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const current = () => mounted.current && isAuthSessionCurrent(owner.current);
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      feedbackTimers.current.delete(timer);
      if (current()) fn();
    }, ms);
    feedbackTimers.current.add(timer);
  };
  useEffect(() => {
    mounted.current = true;
    // StrictMode can replay the mount effect without recreating refs.
    if (ownerAbort.current.signal.aborted) ownerAbort.current = new AbortController();
    return () => {
      mounted.current = false;
      ownerAbort.current.abort();
      feedbackTimers.current.forEach(clearTimeout);
      feedbackTimers.current.clear();
    };
  }, []);

  const [active, setActive] = useState("profile");
  const [billingUsage, setBillingUsage] = useState<BillingUsage | null>(null);
  const [subscription, setSubscription] = useState<BillingSubscription | null>(null);
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [referral, setReferral] = useState<{ code: string; stats: any } | null>(null);
  const [redeemCode, setRedeemCode] = useState("");
  const [redeemResult, setRedeemResult] = useState<string | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [notifs, setNotifs] = useState({
    runCompleted: true, spendApproval: true, pipelineErrors: true,
  });
  const [notifsLoaded, setNotifsLoaded] = useState(false);

  // Profile state — loaded from /users/me, saved via PATCH /users/me
  const [profile, setProfile] = useState<{
    name: string; email: string; emailVerified: boolean;
    tenantName: string; memberSince: string;
  } | null>(null);
  const [profileName, setProfileName] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);

  // AI Provider state
  const [aiConfig, setAiConfig] = useState<{
    provider: string; model: string; hasApiKey: boolean; maskedApiKey?: string | null; baseUrl?: string | null;
  } | null>(null);
  const [aiProvider, setAiProvider] = useState("ANTHROPIC");
  const [aiModel, setAiModel] = useState("claude-sonnet-4-20250514");
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiBaseUrl, setAiBaseUrl] = useState("");
  const [aiSaving, setAiSaving] = useState(false);
  const [aiTesting, setAiTesting] = useState(false);
  const [aiTestResult, setAiTestResult] = useState<{ success: boolean; response?: string; error?: string } | null>(null);
  const [aiSaveMsg, setAiSaveMsg] = useState<string | null>(null);
  const [aiSaveFailed, setAiSaveFailed] = useState(false);
  // Live model catalogue per provider, fetched from the API JIT-proxy
  // endpoint. Missing entry = fall back to the static PROVIDER_LABELS list
  // (endpoint absent, no key stored, or provider unreachable).
  const [liveModels, setLiveModels] = useState<Record<string, string[]>>({});
  const [modelsLoading, setModelsLoading] = useState(false);

  // Integration state
  const [companies, setCompanies] = useState<any[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("");
  const [providers, setProviders] = useState<any[]>([]);
  const [integrations, setIntegrations] = useState<any[]>([]);
  const [intLoading, setIntLoading] = useState(false);
  const [editProvider, setEditProvider] = useState<string | null>(null);
  const [editFields, setEditFields] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<{ provider: string; success: boolean; error?: string } | null>(null);
  const integrationRequest = useRef(0);
  const integrationResource = useRef({ companyId: selectedCompanyId, provider: editProvider });
  integrationResource.current = { companyId: selectedCompanyId, provider: editProvider };
  const modelRequest = useRef(0);
  const selectedAIProvider = useRef(aiProvider);
  selectedAIProvider.current = aiProvider;
  const aiSaveRequest = useRef(0);
  const aiTestRequest = useRef(0);
  const aiDraft = useRef({ aiProvider, aiModel, aiApiKey, aiBaseUrl });
  aiDraft.current = { aiProvider, aiModel, aiApiKey, aiBaseUrl };

  useEffect(() => {
    if (!hydrated || !token) return;
    let active = true;
    const initialDraft = { ...aiDraft.current };
    const publish = () => active && current();
    api.billingUsage(token).then(value => { if (publish()) setBillingUsage(value); }).catch(() => {});
    api.billingSubscription(token).then(value => { if (publish()) setSubscription(value); }).catch(() => {});
    api.getReferral(token).then(value => { if (publish()) setReferral(value); }).catch(() => {});
    api.listProviders(token).then(value => { if (publish()) setProviders(value); }).catch(() => {});
    api.users.me(token).then((u) => {
      if (!publish()) return;
      setProfile({
        name: u.name ?? "",
        email: u.email,
        emailVerified: !!u.emailVerifiedAt,
        tenantName: u.tenant?.name ?? "Workspace",
        memberSince: new Date(u.createdAt).getFullYear().toString(),
      });
      setProfileName(u.name ?? "");
    }).catch(() => {});
    api.getNotificationPrefs(token).then((p) => {
      if (!publish()) return;
      setNotifs({ spendApproval: p.approvals, pipelineErrors: p.risks, runCompleted: p.runs });
      setNotifsLoaded(true);
    }).catch(() => { if (publish()) setNotifsLoaded(true); });
    api.listCompanies(token).then((c: any[]) => {
      if (!publish()) return;
      setCompanies(c);
      if (c.length > 0 && !selectedCompanyId) setSelectedCompanyId(c[0].id);
    }).catch(() => {});
    // Load AI config
    apiFetch<any>("/settings/ai-config", { token, signal: ownerAbort.current.signal })
      .then((cfg) => {
        if (!publish()) return;
        setAiConfig(cfg);
        // Loading persisted settings must not reassign a newly entered key to
        // a different provider/model that the user has already changed.
        if (!Object.keys(initialDraft).every(key => initialDraft[key as keyof typeof initialDraft]
          === aiDraft.current[key as keyof typeof initialDraft])) return;
        setAiProvider(cfg.provider ?? "ANTHROPIC");
        setAiModel(cfg.model ?? "claude-sonnet-4-20250514");
        setAiBaseUrl(cfg.baseUrl ?? "");
      })
      .catch((err) => { if (publish()) { setAiSaveFailed(true); setAiSaveMsg(describeFailure(err, t("app.settings.aiUnknownError"))); } });
    return () => { active = false; };
    // The keyed owner boundary reloads data. A same-owner token rotation must
    // preserve unsaved form edits rather than reload the persisted AI config.
  }, []);

  // Load integrations when company changes
  useEffect(() => {
    if (!token || !selectedCompanyId) return;
    let active = true;
    const request = ++integrationRequest.current;
    const companyId = selectedCompanyId;
    const publish = () => active && current() && request === integrationRequest.current
      && integrationResource.current.companyId === companyId;
    setIntegrations([]); setEditProvider(null); setEditFields({}); setTestResult(null);
    setIntLoading(true);
    api.listIntegrations(token, selectedCompanyId)
      .then(value => { if (publish()) setIntegrations(value); })
      .catch(() => {})
      .finally(() => { if (publish()) setIntLoading(false); });
    return () => { active = false; };
  }, [selectedCompanyId]);

  // Refresh the model catalogue for a provider from the API proxy
  // (GET /settings/ai-providers/:provider/models — server caches 5 min).
  // Defensive parsing: accepts `{ models: string[] }` or a bare string[].
  // Any failure (404 while the endpoint ships, 401, network) silently keeps
  // the static fallback — the selector must never go empty.
  async function loadProviderModels(provider: string) {
    if (!token || !provider) return;
    const request = ++modelRequest.current;
    const publish = () => current() && request === modelRequest.current && selectedAIProvider.current === provider;
    setModelsLoading(true);
    try {
      const data = await apiFetch<unknown>(`/settings/ai-providers/${encodeURIComponent(provider)}/models`, {
        token, signal: ownerAbort.current.signal,
      });
      if (!publish()) return;
      const models: unknown = Array.isArray(data) ? data : (data as { models?: unknown })?.models;
      if (Array.isArray(models) && models.length > 0 && models.every((m) => typeof m === "string")) {
        setLiveModels((prev) => ({ ...prev, [provider]: models as string[] }));
      }
    } catch {
      // static fallback stays in place
    } finally {
      if (publish()) setModelsLoading(false);
    }
  }

  // Fetch live models when the AI Provider panel is open and the selected
  // provider changes (skip if we already have a live list for it).
  useEffect(() => {
    if (active !== "ai_provider" || !token || liveModels[aiProvider]) return;
    loadProviderModels(aiProvider);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, aiProvider]);

  /** Effective model list: live catalogue if fetched, else static fallback.
   * The currently-selected model is always included so the <select> never
   * renders empty when a live list omits the tenant's configured model. */
  function modelsFor(provider: string): string[] {
    const list = liveModels[provider] ?? PROVIDER_LABELS[provider]?.models ?? [];
    if (provider === aiProvider && aiModel && !list.includes(aiModel)) {
      return [aiModel, ...list];
    }
    return list;
  }

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-[60vh] bg-background">
      <div className="w-6 h-6 border-2 rounded-full animate-spin border-outline border-t-primary" />
    </div>
  );

  async function handleUpgrade(plan: "CREATOR" | "PRO" | "BUSINESS" | "ENTERPRISE") {
    if (!current()) return;
    setUpgradeLoading(true);
    setBillingError(null);
    try { const { url } = await api.billingCheckout(token!, plan); if (current()) window.location.href = url; }
    catch (err) { if (current()) setBillingError(describeFailure(err)); }
    if (current()) setUpgradeLoading(false);
  }

  async function handleManageBilling() {
    setBillingError(null);
    try { const { url } = await api.billingPortal(token!); if (current()) window.location.href = url; }
    catch (err) { if (current()) setBillingError(describeFailure(err)); }
  }

  async function handleSaveProfile() {
    if (!token || !profileName.trim() || profileSaving) return;
    setProfileSaving(true);
    try {
      const u = await api.users.updateMe(token, { name: profileName.trim() });
      if (!current()) return;
      setProfile((p) => (p ? { ...p, name: u.name ?? "" } : p));
      setSaved(true);
      toast(t("app.settings.savedToast"), "success");
      later(() => setSaved(false), 2000);
    } catch {
      if (current()) toast(t("app.settings.saveFailedToast"), "error");
    } finally {
      if (current()) setProfileSaving(false);
    }
  }

  async function handleSaveNotifs() {
    if (!token) return;
    try {
      await api.updateNotificationPrefs(token, {
        approvals: notifs.spendApproval,
        risks: notifs.pipelineErrors,
        runs: notifs.runCompleted,
      });
      if (!current()) return;
      setSaved(true);
      toast(t("app.settings.savedToast"), "success");
      later(() => setSaved(false), 2000);
    } catch {
      if (current()) toast(t("app.settings.saveFailedToast"), "error");
    }
  }

  async function handleSaveAiConfig() {
    if (!token || !current()) return;
    const request = ++aiSaveRequest.current;
    const draft = { ...aiDraft.current };
    const publish = () => current() && request === aiSaveRequest.current;
    const sameDraft = () => Object.keys(draft).every(key => draft[key as keyof typeof draft] === aiDraft.current[key as keyof typeof draft]);
    setAiSaving(true);
    setAiSaveMsg(null);
    try {
      const body: Record<string, string> = { provider: aiProvider, model: aiModel };
      if (aiApiKey.trim()) body.apiKey = aiApiKey.trim();
      // baseUrl: pass through for OLLAMA / LMSTUDIO / CUSTOM (or any
      // provider proxy override). Empty string = backend will use the
      // built-in default for that provider.
      if (aiBaseUrl.trim()) body.baseUrl = aiBaseUrl.trim();
      await apiFetch("/settings/ai-config", {
        method: "PUT",
        token, signal: ownerAbort.current.signal,
        body: JSON.stringify(body),
      });
      if (!publish() || !sameDraft()) return;
      setAiConfig((prev) => ({
        ...prev,
        provider: aiProvider,
        model: aiModel,
        hasApiKey: !!aiApiKey || !!prev?.hasApiKey,
        baseUrl: aiBaseUrl.trim() || null,
      }));
      setAiApiKey("");
      setAiSaveFailed(false);
      setAiSaveMsg(t("app.settings.aiSavedToast"));
      later(() => setAiSaveMsg(null), 3000);
    } catch (err) {
      if (!publish() || !sameDraft()) return;
      const message = describeFailure(err, t("app.settings.aiUnknownError"));
      setAiSaveFailed(true);
      setAiSaveMsg(message);
    } finally {
      if (publish()) setAiSaving(false);
    }
  }

  async function handleTestAiConfig() {
    if (!token || !current()) return;
    const request = ++aiTestRequest.current;
    const draft = { ...aiDraft.current };
    const publish = () => current() && request === aiTestRequest.current
      && Object.keys(draft).every(key => draft[key as keyof typeof draft] === aiDraft.current[key as keyof typeof draft]);
    setAiTesting(true);
    setAiTestResult(null);
    try {
      const data = await apiFetch<{ success: boolean; response?: string; error?: string }>("/settings/ai-config/test", {
        method: "POST",
        token, signal: ownerAbort.current.signal,
      });
      if (publish()) setAiTestResult({ ...data, error: data.success ? undefined : describeFailure(data, t("app.settings.aiUnknownError")) });
    } catch (err) {
      if (!publish()) return;
      const message = describeFailure(err, t("app.settings.aiUnknownError"));
      setAiTestResult({ success: false, error: message });
    } finally {
      if (current() && request === aiTestRequest.current) setAiTesting(false);
    }
  }

  async function changeIntegration(action: "save" | "test" | "remove", provider: string) {
    const companyId = selectedCompanyId;
    if (!token || !companyId || !current()) return;
    const request = ++integrationRequest.current;
    const publish = () => current() && request === integrationRequest.current
      && integrationResource.current.companyId === companyId
      && integrationResource.current.provider === provider;
    try {
      if (action === "save") {
        const fields = Object.fromEntries(Object.entries(editFields).filter(([, value]) => value.trim() !== ""));
        if (Object.keys(fields).length === 0) return;
        await api.saveIntegration(token, companyId, provider, fields);
      } else if (action === "test") {
        const result = await api.testIntegration(token, companyId, provider);
        if (!publish()) return;
        setTestResult({ provider, success: result.success, error: result.success ? undefined : describeFailure(result, t("app.settings.aiUnknownError")) });
      } else await api.deleteIntegration(token, companyId, provider);
      if (!publish()) return;
      const liveToken = useAppStore.getState().token;
      if (!liveToken) return;
      const updated = await api.listIntegrations(liveToken, companyId);
      if (!publish()) return;
      setIntegrations(updated);
      if (action === "save") setEditFields({});
    } catch (err) {
      if (publish()) setTestResult({ provider, success: false, error: describeFailure(err, t("app.settings.aiUnknownError")) });
    }
  }

  const currentPlan = billingUsage?.plan ?? "FREE";
  const limits = PLAN_LIMITS[currentPlan] ?? PLAN_LIMITS.FREE;

  return (
    <div className="bv-dash-shell min-h-screen">
      {/* Top bar */}
      <header className="sticky top-0 z-40 flex items-center justify-between px-6 h-14 glass-panel border-b border-outline-variant/20">
        <div className="flex items-center gap-4">
          {/* breadcrumb */}
          <div className="flex items-center gap-2 text-xs font-semibold tracking-[0.08em] uppercase text-on-surface-variant">
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>settings</span>
            <span>{uiText("m239b7819863d")}</span>
          </div>
        </div>
        <button
          onClick={() => { void api.signOut(); router.replace("/login"); }}
          className="bv-btn bv-btn-sm bv-btn-danger flex items-center gap-1.5"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 15 }}>logout</span>
          {t("app.settings.signOut")}
        </button>
      </header>

      {/* Page layout: sticky subnav + content */}
      <div className="max-w-[920px] mx-auto px-6 py-8">

        {/* Page head */}
        <div className="bv-page-head mb-7">
          <div>
            <p className="bv-micro text-outline mb-1">{uiText("m82be07e8418a")}</p>
            <h1 className="bv-headline text-on-surface">{uiText("m239b7819863d")}</h1>
            <p className="bv-caption mt-1">{uiText("m4c903bb74ed9")}</p>
          </div>
        </div>

        {/* Two-column settings wrap */}
        <div className="grid gap-7" style={{ gridTemplateColumns: "200px 1fr", alignItems: "start" }}>

          {/* Sticky subnav */}
          <nav className="flex flex-col gap-0.5" style={{ position: "sticky", top: "80px" }}>
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                onClick={() => setActive(item.id)}
                className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all text-left"
                style={{
                  color: active === item.id ? "var(--color-on-surface)" : "var(--color-on-surface-variant)",
                  background: active === item.id ? "rgba(59,130,246,0.08)" : "transparent",
                  borderInlineStart: `2px solid ${active === item.id ? "var(--color-primary)" : "transparent"}`,
                }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16, opacity: active === item.id ? 1 : 0.6 }}>{item.icon}</span>
                {t(`app.settings.${item.labelKey}`)}
              </button>
            ))}
            {/* Danger zone */}
            <button
              onClick={() => setActive("danger")}
              className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all text-left mt-2"
              style={{
                color: active === "danger" ? "var(--color-error)" : "var(--color-on-surface-variant)",
                background: active === "danger" ? "rgba(255,77,77,0.08)" : "transparent",
                borderInlineStart: `2px solid ${active === "danger" ? "var(--color-error)" : "transparent"}`,
              }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16, color: "var(--color-error)", opacity: active === "danger" ? 1 : 0.6 }}>warning</span>{uiText("m2255caa19025")}</button>
          </nav>

          {/* Section panels */}
          <div className="animate-fade-in">

            {/* ── Profile ── */}
            {active === "profile" && (
              <ForgeSection title={t("app.settings.profileTitle")} subtitle={t("app.settings.profileSubtitle")} icon="person">
                <div className="flex items-center gap-4 mb-6 pb-6 border-b border-outline-variant/20">
                  <div className="bv-avatar bv-avatar-lg">
                    {(profile?.name || profile?.email || tenantId || "AI").slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <p className="bv-title font-headline font-bold">{profile?.tenantName ?? "—"}</p>
                    {profile?.memberSince && (
                      <p className="bv-caption mt-0.5">{t("app.settings.memberSince", { year: profile.memberSince })}</p>
                    )}
                    <span className="bv-pill bv-pill-cyan mt-1.5 inline-flex">
                      {currentPlan}
                    </span>
                  </div>
                </div>

                <div className="mb-3.5">
                  <ForgeField
                    label={t("app.settings.fieldName")}
                    placeholder={uiText("m251011545863")}
                    value={profileName}
                    onChange={setProfileName}
                  />
                </div>
                <ForgeField
                  label={t("app.settings.fieldEmail")}
                  placeholder="you@example.com"
                  value={profile?.email ?? ""}
                  readOnly
                  badge={profile?.emailVerified ? t("app.settings.verifiedBadge") : undefined}
                />
                <ForgeSaveBar onSave={handleSaveProfile} saved={saved} />
              </ForgeSection>
            )}

            {/* ── Notifications ── */}
            {active === "notifications" && (
              <ForgeSection title={t("app.settings.notificationsTitle")} subtitle={t("app.settings.notificationsSubtitle")} icon="notifications">
                <div>
                  {([
                    { key: "spendApproval" as const, label: runtimeCopy("m6dc7542014dc"), desc: runtimeCopy("m29a34a94a498"), critical: true },
                    { key: "pipelineErrors" as const, label: runtimeCopy("m84ed19090410"), desc: runtimeCopy("mb195583a6e7f"), critical: true },
                    { key: "runCompleted" as const, label: runtimeCopy("m13641fc2a8c0"), desc: runtimeCopy("m6e87b3db013a") },
                  ]).map((item) => (
                    <div
                      key={item.key}
                      className="flex items-center justify-between py-3.5 border-b border-outline-variant/15 last:border-0"
                    >
                      <div className="flex items-start gap-2.5">
                        {item.critical && (
                          <span className="bv-pill bv-pill-amber mt-0.5 flex-shrink-0">{uiText("m7f8ad1ba2dfe")}</span>
                        )}
                        <div>
                          <p className="text-sm font-medium text-on-surface">{item.label}</p>
                          <p className="bv-caption mt-0.5">{item.desc}</p>
                        </div>
                      </div>
                      {/* Toggle */}
                      <button
                        onClick={() => setNotifs((n) => ({ ...n, [item.key]: !n[item.key] }))}
                        className="relative flex-shrink-0 w-11 h-6 rounded-full transition-all ml-4"
                        style={{
                          background: notifs[item.key]
                            ? "var(--bv-cobalt-glow)"
                            : "var(--color-surface-container-high)",
                          border: `1px solid ${notifs[item.key] ? "rgba(59,130,246,0.5)" : "var(--color-outline-variant)"}`,
                          boxShadow: notifs[item.key] ? "0 0 10px rgba(59,130,246,0.25)" : "none",
                        }}
                        aria-pressed={notifs[item.key]}
                      >
                        <div
                          className="absolute top-0.5 h-5 w-5 rounded-full transition-all bg-white shadow"
                          style={{ left: notifs[item.key] ? "calc(100% - 22px)" : "2px" }}
                        />
                      </button>
                    </div>
                  ))}
                </div>
                {!notifsLoaded && (
                  <p className="bv-caption mt-2" style={{ color: "var(--color-outline)" }}>…</p>
                )}
                <ForgeSaveBar onSave={handleSaveNotifs} saved={saved} />
              </ForgeSection>
            )}

            {/* ── Billing ── */}
            {active === "billing" && (
              <ForgeSection title={t("app.settings.billingTitle")} subtitle={t("app.settings.billingSubtitle")} icon="credit_card">
                {billingError && (
                  <div className="mb-4 px-4 py-3 rounded-xl bg-error-container/20 border border-error/25 text-error text-sm">
                    {billingError}
                  </div>
                )}

                <div className="flex items-center justify-between mb-5 pb-5 border-b border-outline-variant/15">
                  <div className="flex items-center gap-3">
                    <span className="bv-pill bv-pill-cyan">{currentPlan}{" "}{uiText("m5836e3f6f284")}</span>
                    {subscription?.subscription && (
                      <span className="bv-caption">
                        {subscription.subscription.cancelAtPeriodEnd
                          ? t("surface.billing.cancels", { date: formatDisplayDateTime(subscription.subscription.currentPeriodEnd, displayLocale, { timeZone: displayTimeZone(), dateStyle: "medium" }) })
                          : t("surface.billing.renews", { date: formatDisplayDateTime(subscription.subscription.currentPeriodEnd, displayLocale, { timeZone: displayTimeZone(), dateStyle: "medium" }) })}
                      </span>
                    )}
                  </div>
                  {subscription?.stripeCustomerId && (
                    <button
                      onClick={handleManageBilling}
                      className="text-xs font-semibold text-primary hover:opacity-80 transition-opacity"
                    >
                      {t("app.settings.manageBilling")}
                    </button>
                  )}
                </div>

                {billingUsage && (
                  <div className="space-y-3.5 mb-7">
                    <ForgeUsageBar label={t("app.settings.runsThisMonth")} current={billingUsage.live.runs} limit={limits.runs} />
                    <div className="flex justify-between text-sm">
                      <span className="text-on-surface-variant">{uiText("m70d993f4aae7")}</span>
                      <span className="font-semibold text-on-surface">{billingUsage.live.toolCalls}</span>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3.5">
                  {PLAN_ORDER.map((id) => {
                    const planLimits = SHARED_PLAN_LIMITS[id];
                    const pricing = PLAN_PRICING[id];
                    const isFree = id === "FREE";
                    const isEnt = id === "ENTERPRISE";
                    const price = isFree ? "$0" : isEnt ?uiText("m81a36cd86bb2") : runtimeCopy("m9d5e808eecb2", { value0: pricing.monthlyUsd });
                    const features: string[] = [
                      planLimits.maxCompanies === -1 ?uiText("m70488646d660") : runtimeCopy("workspaces", { count: planLimits.maxCompanies }),
                      planLimits.maxRunsPerMonth === -1 ?uiText("mc6572473d51f") : runtimeCopy("m26f640894104", { count: planLimits.maxRunsPerMonth }),
                      planLimits.maxConnectedAutomations === -1 ?uiText("m18629becb717") : runtimeCopy("connectedAutomations", { count: planLimits.maxConnectedAutomations }),
                      ...(planLimits.localProvider ? [runtimeCopy("m5e369d5a7fd5")] : []),
                      ...planLimits.features.includes("crm_sync") ? ["CRM sync"] : [],
                      ...planLimits.features.includes("sso") ? ["SSO"] : [],
                      ...planLimits.features.includes("sla") ? ["SLA"] : [],
                    ].slice(0, 5);
                    const popular = id === "PRO";
                    return { name: PLAN_LABEL[id], price, id, popular, features };
                  }).map((plan) => (
                    <div
                      key={plan.id}
                      className="bv-glass rounded-xl p-3.5 flex flex-col"
                      style={{
                        background: currentPlan === plan.id
                          ? "rgba(59,130,246,0.06)"
                          : "var(--bv-glass-bg)",
                        borderColor: currentPlan === plan.id
                          ? "rgba(59,130,246,0.3)"
                          : "var(--bv-glass-border)",
                      }}
                    >
                      {plan.popular && currentPlan !== plan.id && (
                        <span className="bv-pill bv-pill-cyan mb-2 self-start">
                          {t("app.settings.mostPopular")}
                        </span>
                      )}
                      <p className="font-headline font-semibold text-sm text-on-surface mb-0.5">{plan.name}</p>
                      <p className="bv-numeric text-lg text-primary mb-2">{plan.price}</p>
                      {currentPlan === plan.id && (
                        <span className="bv-pill bv-pill-cyan mb-2 self-start">{uiText("m9d2f4b435f53")}</span>
                      )}
                      <ul className="text-xs space-y-1 mb-3.5 flex-1 text-on-surface-variant">
                        {plan.features.map((f) => (
                          <li key={f} className="flex items-center gap-1.5">
                            <div className="w-1 h-1 rounded-full bg-primary flex-shrink-0" />
                            {f}
                          </li>
                        ))}
                      </ul>
                      {currentPlan !== plan.id && plan.id !== "FREE" && (
                        plan.id === "ENTERPRISE" ? (
                          <a
                            href="mailto:founder@braavolabs.com?subject=Enterprise%20plan%20inquiry"
                            className="bv-btn bv-btn-primary bv-btn-sm w-full justify-center"
                          >{uiText("m55b34f1cdcf3")}</a>
                        ) : (
                          <button
                            onClick={() => handleUpgrade(plan.id as "CREATOR" | "PRO" | "BUSINESS")}
                            disabled={upgradeLoading}
                            className="bv-btn bv-btn-primary bv-btn-sm w-full justify-center disabled:opacity-50"
                          >{uiText("m245c12189d91")}</button>
                        )
                      )}
                    </div>
                  ))}
                </div>
              </ForgeSection>
            )}

            {/* ── Integrations ── */}
            {active === "integrations" && (
              <ForgeSection title={t("app.settings.integrationsTitle")} subtitle={t("app.settings.integrationsSubtitle")} icon="hub">
                <div className="mb-5">
                  <label className="bv-micro text-outline mb-2 block">{uiText("mca4ac26863e8")}</label>
                  <select
                    value={selectedCompanyId}
                    onChange={(e) => {
                      integrationRequest.current++;
                      integrationResource.current = { companyId: e.target.value, provider: null };
                      setSelectedCompanyId(e.target.value);
                      setIntegrations([]); setEditProvider(null); setEditFields({}); setTestResult(null);
                    }}
                    className="w-full px-3.5 py-2.5 rounded-xl text-sm bg-surface-container border border-outline-variant/30 text-on-surface outline-none focus:border-primary/50 transition-colors"
                  >
                    {companies.map((c) => (
                      <option key={c.id} value={c.id} style={{ background: "var(--color-surface-container)" }}>{c.name}</option>
                    ))}
                    {companies.length === 0 && <option value="">{t("app.settings.noCompaniesFound")}</option>}
                  </select>
                </div>

                {intLoading ? (
                  <div className="text-center py-10">
                    <div className="w-5 h-5 border-2 rounded-full animate-spin mx-auto mb-2 border-outline border-t-primary" />
                    <p className="bv-caption">{uiText("md734f81167bd")}</p>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {providers.map((prov) => {
                      const existing = integrations.find((i: any) => i.provider === prov.provider);
                      const isEditing = editProvider === prov.provider;
                      const statusColor = existing?.status === "ACTIVE" ?"var(--bv-status-completed)" : existing?.status === "ERROR" ?"var(--bv-status-failed)" : existing?.status === "PENDING" ?"var(--bv-status-running)" :"var(--color-outline)";
                      const statusLabel = existing?.status ?? t("app.settings.notConnected");

                      return (
                        <div key={prov.provider} className="bv-glass rounded-xl overflow-hidden">
                          <div
                            className="flex items-center justify-between px-4 py-3.5 cursor-pointer"
                            onClick={() => {
                              integrationRequest.current++;
                              integrationResource.current.provider = isEditing ? null : prov.provider;
                              if (isEditing) {
                                setEditProvider(null);
                              } else {
                                setEditProvider(prov.provider);
                                setEditFields({});
                                setTestResult(null);
                              }
                            }}
                          >
                            <div className="flex items-center gap-3">
                              <span className="text-xl">{prov.icon}</span>
                              <div>
                                <p className="text-sm font-semibold text-on-surface">{prov.name}</p>
                                <p className="bv-caption">{prov.description}</p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2.5">
                              <span
                                className="bv-pill"
                                style={{ color: statusColor, background: `${statusColor}18`, borderColor: `${statusColor}40` }}
                              >
                                {statusLabel}
                              </span>
                              <span
                                className="material-symbols-outlined text-outline"
                                style={{ fontSize: 18, transform: isEditing ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}
                              >
                                expand_more
                              </span>
                            </div>
                          </div>

                          {isEditing && (
                            <div className="px-4 pb-4 pt-1 border-t border-outline-variant/15">
                              <div className="mb-3.5 p-3 rounded-xl bg-primary/5 border border-primary/15">
                                <p className="bv-micro text-primary mb-1.5">{uiText("m0530d4879653")}</p>
                                <pre className="text-xs whitespace-pre-wrap text-on-surface-variant">{prov.setupGuide}</pre>
                                {prov.docsUrl && (
                                  <a href={prov.docsUrl} target="_blank" rel="noopener noreferrer" className="text-xs mt-2 inline-block text-primary">
                                    {t("app.settings.viewDocumentation")}
                                  </a>
                                )}
                              </div>

                              <div className="space-y-2.5">
                                {prov.fields.map((field: any) => (
                                  <div key={field.key}>
                                    <label className="bv-caption font-semibold mb-1 block text-on-surface-variant">
                                      {field.label}
                                      {existing?.fieldsSet?.includes(field.key) && (
                                        <span className="ml-2 text-[10px] text-primary">{uiText("m2c575197fbcf")}</span>
                                      )}
                                    </label>
                                    <input
                                      type={field.type}
                                      placeholder={field.placeholder}
                                      value={editFields[field.key] ?? ""}
                                      onChange={(e) => setEditFields((prev) => ({ ...prev, [field.key]: e.target.value }))}
                                      className="w-full px-3 py-2 rounded-xl text-sm font-mono bg-surface-container border border-outline-variant/30 text-on-surface outline-none focus:border-primary/50 transition-colors"
                                    />
                                  </div>
                                ))}
                              </div>

                              {testResult && testResult.provider === prov.provider && (
                                <div
                                  className="mt-3 p-3 rounded-xl text-xs"
                                  style={{
                                    background: testResult.success ? "rgba(59,130,246,0.08)" : "rgba(255,77,77,0.08)",
                                    border: `1px solid ${testResult.success ? "rgba(59,130,246,0.2)" : "rgba(255,77,77,0.2)"}`,
                                    color: testResult.success ? "var(--color-primary)" : "var(--color-error)",
                                  }}
                                >
                                  {testResult.success ? t("app.settings.connectionSuccessful") : testResult.error ?? t("app.settings.aiUnknownError")}
                                </div>
                              )}

                              <div className="flex gap-2 mt-3.5">
                                <button
                                  onClick={() => changeIntegration("save", prov.provider)}
                                  className="bv-btn bv-btn-primary bv-btn-sm"
                                >
                                  {t("app.settings.saveCredentials")}
                                </button>
                                <button
                                  onClick={() => changeIntegration("test", prov.provider)}
                                  className="bv-btn bv-btn-ghost bv-btn-sm"
                                >{uiText("m2f159920cfcf")}</button>
                                {existing && (
                                  <button
                                    onClick={() => changeIntegration("remove", prov.provider)}
                                    className="bv-btn bv-btn-danger bv-btn-sm ml-auto"
                                  >{uiText("m5d0a3ab02ef8")}</button>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </ForgeSection>
            )}

            {/* ── Governance ── */}
            {active === "governance" && (
              <ForgeSection title={t("app.settings.governanceTitle")} subtitle={t("app.settings.governanceSubtitle")} icon="security">
                <div>
                  {[
                    { label: runtimeCopy("mc058d692e6cc"), value: runtimeCopy("me68fc6aed4e7") },
                    { label: runtimeCopy("m04508baa9aeb"), value: runtimeCopy("m4021017c235b") },
                    { label: runtimeCopy("m6774e7b32e15"), value: runtimeCopy("md2687779b5c7") },
                    { label: runtimeCopy("m51e462c03da2"), value: runtimeCopy("m10bc771116e0") },
                    { label: runtimeCopy("m7ae7fcaafb64"), value: runtimeCopy("me92d7c3eb5e2") },
                    { label: runtimeCopy("m74769711684e"), value: runtimeCopy("m27e8635ece5f") },
                  ].map((item) => (
                    <div
                      key={item.label}
                      className="flex justify-between items-center py-3.5 border-b border-outline-variant/15 last:border-0"
                    >
                      <span className="text-sm text-on-surface-variant">{item.label}</span>
                      <code className="bv-mono px-2.5 py-1 rounded-lg bg-surface-container border border-outline-variant/20 text-outline">
                        {item.value}
                      </code>
                    </div>
                  ))}
                </div>
              </ForgeSection>
            )}

            {/* ── AI Provider ── */}
            {active === "ai_provider" && (
              <ForgeSection title={t("app.settings.aiTitle")} subtitle={t("app.settings.aiSubtitle")} icon="smart_toy">
                <div className="space-y-5">

                  {/* Provider selector */}
                  <div>
                    <p className="bv-micro text-outline mb-3">{uiText("mf1fd0aaf6045")}</p>
                    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                      {Object.entries(PROVIDER_LABELS).map(([id, info]) => {
                        const planAllowsLocal = planAllowsLocalProvider(currentPlan);
                        const locked = !!info.local && !planAllowsLocal;
                        return (
                          <button
                            key={id}
                            onClick={() => {
                              if (locked) return;
                                selectedAIProvider.current = id;
                                modelRequest.current++;
                                setModelsLoading(false); setAiTestResult(null); setAiSaveMsg(null);
                              setAiProvider(id);
                              setAiModel(modelsFor(id)[0] ?? "");
                            }}
                            className="flex items-center gap-2.5 p-3.5 rounded-xl text-left transition-all"
                            style={{
                              background: aiProvider === id ? "rgba(59,130,246,0.08)" : "var(--color-surface-container)",
                              border: `1px solid ${aiProvider === id ? "rgba(59,130,246,0.4)" : "var(--color-outline-variant)"}`,
                              opacity: locked ? 0.5 : 1,
                              cursor: locked ? "not-allowed" : "pointer",
                            }}
                            title={locked ? t("app.settings.localPlanRequired") : ""}
                            disabled={locked}
                            aria-pressed={aiProvider === id}
                          >
                            <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: info.color }} />
                            <span className="text-xs font-semibold truncate" style={{ color: aiProvider === id ? "var(--color-on-surface)" : "var(--color-on-surface-variant)" }}>
                              {info.label}
                              {locked && <span className="ml-1 text-primary"> · {t("app.settings.planRequired")}</span>}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Plan-gate banner */}
                  {PROVIDER_LABELS[aiProvider]?.local && !planAllowsLocalProvider(currentPlan) && (
                    <div className="rounded-xl px-4 py-3 text-xs flex items-start gap-3 bg-primary/5 border border-primary/20 text-on-surface-variant">
                      <span className="material-symbols-outlined text-primary flex-shrink-0 mt-0.5" style={{ fontSize: 18 }}>workspace_premium</span>
                      <div className="flex-1">
                        <p className="font-semibold mb-1 text-on-surface">{t("app.settings.localPlanRequired")}</p>
                        <p>{t("app.settings.localPlanDescription")}</p>
                        <a href="/pricing" className="bv-btn bv-btn-primary bv-btn-sm mt-2 inline-flex">{t("app.settings.viewPlans")}</a>
                      </div>
                    </div>
                  )}

                  {/* Local setup hint */}
                  {PROVIDER_LABELS[aiProvider]?.local && planAllowsLocalProvider(currentPlan) && PROVIDER_LABELS[aiProvider]?.setupHint && (
                    <div className="rounded-xl px-3.5 py-2.5 text-xs bg-primary/5 border border-primary/20">
                      <p className="font-semibold mb-1 text-primary">{uiText("m9583131210fc")}</p>
                      <p className="text-on-surface-variant">{PROVIDER_LABELS[aiProvider]?.setupHint}</p>
                    </div>
                  )}

                  {/* Model selector */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <p className="bv-micro text-outline">{uiText("m4cb1ce4d7ccb")}{PROVIDER_LABELS[aiProvider]?.local && aiProvider !== "CUSTOM" && (
                          <span className="ml-2 font-normal normal-case text-[10px] text-outline opacity-60">{uiText("md100640b1368")}</span>
                        )}
                      </p>
                      <button
                        onClick={() => loadProviderModels(aiProvider)}
                        disabled={modelsLoading}
                        className="bv-btn bv-btn-ghost bv-btn-sm flex items-center gap-1 disabled:opacity-50"
                        title={t("app.settings.aiModelsRefresh")}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 13 }}>refresh</span>
                        {modelsLoading ? t("app.settings.aiModelsRefreshing") : t("app.settings.aiModelsRefresh")}
                      </button>
                    </div>
                    {PROVIDER_LABELS[aiProvider]?.local ? (
                      <input
                        type="text"
                        list={`${aiProvider}-models`}
                        value={aiModel}
                        onChange={(e) => setAiModel(e.target.value)}
                        placeholder={aiProvider === "OLLAMA" ?uiText("mdfe713d713c5") : aiProvider === "LMSTUDIO" ?"google/gemma-3-4b-it" :"model-name"}
                        className="w-full px-3.5 py-2.5 rounded-xl text-sm font-mono bg-surface-container border border-outline-variant/30 text-on-surface outline-none focus:border-primary/50 transition-colors"
                      />
                    ) : (
                      <select
                        value={aiModel}
                        onChange={(e) => setAiModel(e.target.value)}
                        className="w-full px-3.5 py-2.5 rounded-xl text-sm font-mono bg-surface-container border border-outline-variant/30 text-on-surface outline-none focus:border-primary/50 transition-colors"
                      >
                        {modelsFor(aiProvider).map((m) => (
                          <option key={m} value={m} style={{ background: "var(--color-surface-container)" }}>{m}</option>
                        ))}
                      </select>
                    )}
                    <datalist id={`${aiProvider}-models`}>
                      {modelsFor(aiProvider).map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                    {/* Catalogue source badge: live proxy list vs built-in fallback */}
                    <p className="text-[10px] mt-1 text-outline opacity-60">
                      {liveModels[aiProvider] ? t("app.settings.aiModelsLive") : t("app.settings.aiModelsStatic")}
                    </p>
                  </div>

                  {/* Base URL */}
                  {(PROVIDER_LABELS[aiProvider]?.local || aiBaseUrl) && (
                    <div>
                      <p className="bv-micro text-outline mb-1">
                        {t("app.settings.aiBaseUrl")}
                        {!PROVIDER_LABELS[aiProvider]?.local && (
                          <span className="ml-2 font-normal normal-case text-[10px] opacity-60">{uiText("ma9ef66d953f7")}</span>
                        )}
                        {aiProvider === "CUSTOM" && (
                          <span className="ml-2 font-normal normal-case text-[10px] text-error">{uiText("m03032587881b")}</span>
                        )}
                      </p>
                      <input
                        type="text"
                        placeholder={PROVIDER_LABELS[aiProvider]?.defaultBaseUrl || "https://your-endpoint/v1"}
                        value={aiBaseUrl}
                        onChange={(e) => setAiBaseUrl(e.target.value)}
                        className="w-full px-3.5 py-2.5 rounded-xl text-sm font-mono bg-surface-container border border-outline-variant/30 text-on-surface outline-none focus:border-primary/50 transition-colors"
                      />
                      {PROVIDER_LABELS[aiProvider]?.defaultBaseUrl && !aiBaseUrl && (
                        <p className="text-[10px] mt-1 text-outline opacity-60">{uiText("m59f3ac725629")}{" "}<code>{PROVIDER_LABELS[aiProvider].defaultBaseUrl}</code>
                        </p>
                      )}
                    </div>
                  )}

                  {/* API Key */}
                  {!PROVIDER_LABELS[aiProvider]?.local && (
                    <div>
                      <p className="bv-micro text-outline mb-1">{uiText("m0b1070b5d324")}{aiConfig?.hasApiKey && (
                          <span className="ml-2 font-normal normal-case text-[10px] text-primary">
                            {t("app.settings.aiKeyConfiguredPrefix")} ({aiConfig.maskedApiKey})
                          </span>
                        )}
                      </p>
                      <p className="bv-caption mb-2 text-outline opacity-70">
                        {aiProvider === "ANTHROPIC" && "Get your key from console.anthropic.com"}
                        {aiProvider === "OPENAI" && "Get your key from platform.openai.com"}
                        {aiProvider === "GOOGLE" && "Get your key from aistudio.google.com"}
                        {aiProvider === "MISTRAL" && "Get your key from console.mistral.ai"}
                        {aiProvider === "GROQ" && "Get your key from console.groq.com"}
                        {aiProvider === "OPENROUTER" && "Get your key from openrouter.ai/keys"}
                        {aiProvider === "DEEPSEEK" && "Get your key from platform.deepseek.com"}
                        {aiProvider === "KIMI" && "Get your key from platform.moonshot.ai"}
                        {aiProvider === "QWEN" && "Get your key from Alibaba Cloud Model Studio (DashScope) console"}
                      </p>
                      <input
                        type="password"
                        placeholder={aiConfig?.hasApiKey ? t("app.settings.aiLeavePlaceholder") :"sk-..."}
                        value={aiApiKey}
                        onChange={(e) => setAiApiKey(e.target.value)}
                        className="w-full px-3.5 py-2.5 rounded-xl text-sm font-mono bg-surface-container border border-outline-variant/30 text-on-surface outline-none focus:border-primary/50 transition-colors"
                      />
                    </div>
                  )}
                  {PROVIDER_LABELS[aiProvider]?.local && aiProvider === "CUSTOM" && (
                    <div>
                      <p className="bv-micro text-outline mb-1">{uiText("m0b1070b5d324")}{" "}<span className="font-normal normal-case opacity-60">{uiText("mdd0a21379699")}</span>
                      </p>
                      <input
                        type="password"
                        placeholder={uiText("m9bf0b94f3d0d")}
                        value={aiApiKey}
                        onChange={(e) => setAiApiKey(e.target.value)}
                        className="w-full px-3.5 py-2.5 rounded-xl text-sm font-mono bg-surface-container border border-outline-variant/30 text-on-surface outline-none focus:border-primary/50 transition-colors"
                      />
                    </div>
                  )}

                  {/* Save message */}
                  {aiSaveMsg && (
                    <div
                      className="px-4 py-3 rounded-xl text-xs font-semibold"
                      style={{
                        background: aiSaveFailed ? "rgba(255,77,77,0.08)" : "rgba(59,130,246,0.08)",
                        color: aiSaveFailed ? "var(--color-error)" : "var(--color-primary)",
                        border: `1px solid ${aiSaveFailed ? "rgba(255,77,77,0.2)" : "rgba(59,130,246,0.2)"}`,
                      }}
                    >
                      {aiSaveMsg}
                    </div>
                  )}

                  {/* Test result */}
                  {aiTestResult && (
                    <div
                      className="px-4 py-3 rounded-xl text-xs"
                      style={{
                        background: aiTestResult.success ? "rgba(59,130,246,0.06)" : "rgba(255,77,77,0.06)",
                        border: `1px solid ${aiTestResult.success ? "rgba(59,130,246,0.2)" : "rgba(255,77,77,0.2)"}`,
                        color: aiTestResult.success ? "var(--color-primary)" : "var(--color-error)",
                      }}
                    >
                      {aiTestResult.success
                        ? runtimeCopy("m31f4062639ad", { value0: aiTestResult.response ?? "—" })
                        : aiTestResult.error ?? t("app.settings.aiUnknownError")}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-3">
                    <button
                      onClick={handleSaveAiConfig}
                      disabled={aiSaving}
                      className="bv-btn bv-btn-primary flex-1 disabled:opacity-50"
                    >
                      {aiSaving ? t("app.settings.aiSaving") : t("app.settings.aiSaveButton")}
                    </button>
                    {(() => {
                      const cfgProvider = aiConfig?.provider ?? aiProvider;
                      const isLocal = !!PROVIDER_LABELS[cfgProvider]?.local;
                      const canTest = isLocal || !!aiConfig?.hasApiKey;
                      return (
                        <button
                          onClick={handleTestAiConfig}
                          disabled={aiTesting || !canTest}
                          title={canTest ? "" :uiText("m6f1791e21588")}
                          className="bv-btn bv-btn-ghost disabled:opacity-40"
                        >
                          {aiTesting ? t("app.settings.aiTesting") : t("app.settings.testConnection")}
                        </button>
                      );
                    })()}
                  </div>

                  {/* Info box */}
                  <div className="p-4 rounded-xl bg-surface-container border border-outline-variant/20 text-xs text-on-surface-variant">
                    <p className="font-semibold mb-1 text-on-surface">{uiText("m5ae1c6a8e4c6")}</p>
                    <p>{t("app.settings.aiStorageDescription")}</p>
                    <p className="mt-2">{t("app.settings.localEndpointDescription")}</p>
                  </div>
                </div>
              </ForgeSection>
            )}

            {/* ── API & Auth ── */}
            {active === "api" && (
              <ForgeSection title={uiText("m350c849d3a6f")} subtitle={uiText("m41c85b6bacc7")} icon="terminal">
                <div className="space-y-3.5">
                  <div className="p-4 rounded-xl bg-surface-container border border-outline-variant/20">
                    <p className="bv-micro text-outline mb-1.5">{uiText("m995515c1ae9f")}</p>
                    <div className="flex items-center gap-3">
                      <code className="text-sm flex-1 truncate bv-mono text-on-surface-variant">
                        {tenantId ? `${tenantId.slice(0, 4)}...${tenantId.slice(-4)}` : "—"}
                      </code>
                      <button
                        className="bv-btn bv-btn-ghost bv-btn-sm"
                        onClick={() => tenantId && navigator.clipboard.writeText(tenantId)}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>content_copy</span>{uiText("mf516b06d11bf")}</button>
                    </div>
                  </div>
                  <div className="p-4 rounded-xl bg-surface-container border border-outline-variant/20">
                    <p className="bv-micro text-outline mb-1.5">{uiText("m0e13854c1b01")}</p>
                    <code className="text-sm bv-mono text-on-surface-variant">
                      {token ? `${token.slice(0, 24)}...` : "—"}
                    </code>
                  </div>
                </div>
              </ForgeSection>
            )}

            {/* ── Webhooks ── */}
            {active === "webhooks" && (
              <ForgeSection title={uiText("maddc6b1a8edb")} subtitle={uiText("m85f417bbfec5")} icon="webhook">
                <div className="space-y-4">
                  <div className="p-4 rounded-xl bg-surface-container border border-outline-variant/20">
                    <div className="flex items-center gap-2 mb-2.5">
                      <span className="material-symbols-outlined text-primary" style={{ fontSize: 18 }}>webhook</span>
                      <p className="text-sm font-semibold text-on-surface">{uiText("mfee4f2dabe8d")}</p>
                    </div>
                    <p className="bv-caption mb-3">{uiText("m684490cc61e5")}</p>
                    <div className="rounded-xl p-3 bg-background/60 border border-outline-variant/15">
                      <p className="bv-micro text-outline mb-1.5">{uiText("m6665da29a7e3")}</p>
                      <code className="bv-mono text-primary">POST /hooks/:company_slug/:event</code>
                    </div>
                    <p className="bv-caption mt-2 text-outline opacity-70">{uiText("mfd15b81d8cf9")}{" "}<code className="text-primary">:company_slug</code>{" "}{uiText("m0a04f470671e")}{" "}<code className="text-primary">:event</code>{" "}{uiText("mfcbffc247eb8")}</p>
                  </div>

                  <div className="p-4 rounded-xl bg-surface-container border border-outline-variant/20">
                    <div className="flex items-center gap-2 mb-2.5">
                      <span className="material-symbols-outlined" style={{ fontSize: 18, color: "#f59e0b" }}>key</span>
                      <p className="text-sm font-semibold text-on-surface">{uiText("m63afb9032824")}</p>
                    </div>
                    <div className="flex items-center gap-3 mb-2">
                      <code className="text-sm flex-1 truncate bv-mono text-on-surface-variant">
                        Bearer {token ? `${token.slice(0, 20)}...` : "—"}
                      </code>
                      <button
                        className="bv-btn bv-btn-ghost bv-btn-sm"
                        onClick={() => token && navigator.clipboard.writeText(token)}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 13 }}>content_copy</span>{uiText("mf516b06d11bf")}</button>
                    </div>
                    <p className="bv-caption text-outline opacity-70">{uiText("m4b6ee96c2cfc")}</p>
                  </div>

                  <div>
                    <p className="text-xs font-semibold mb-3 text-on-surface-variant">{uiText("me55571b3240f")}</p>
                    <div>
                      {[
                        { event: "new_lead", desc: runtimeCopy("mf0b59374b988"), icon: "person_add" },
                        { event: "content_ready", desc: runtimeCopy("mc3af8f5ac774"), icon: "check_circle" },
                        { event: "payment_received", desc: runtimeCopy("m5275b74361ed"), icon: "payments" },
                        { event: "support_ticket", desc: runtimeCopy("m1cd72a8c1a04"), icon: "support_agent" },
                      ].map((ev) => (
                        <div
                          key={ev.event}
                          className="flex items-center justify-between py-3 border-b border-outline-variant/15 last:border-0"
                        >
                          <div className="flex items-center gap-3">
                            <span className="material-symbols-outlined text-outline" style={{ fontSize: 16 }}>{ev.icon}</span>
                            <div>
                              <code className="bv-mono text-on-surface">{ev.event}</code>
                              <p className="bv-caption opacity-70">{ev.desc}</p>
                            </div>
                          </div>
                          <button
                            className="bv-btn bv-btn-ghost bv-btn-sm"
                            onClick={() => navigator.clipboard.writeText(`/hooks/YOUR_COMPANY/${ev.event}`)}
                          >{uiText("m13a00239ea2d")}</button>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="p-4 rounded-xl bg-primary/4 border border-primary/15">
                    <p className="text-xs font-semibold mb-2 text-primary">{uiText("mef57c1e54f93")}</p>
                    <code className="bv-mono block text-on-surface-variant">
                      curl -X POST {typeof window !== "undefined" ? window.location.origin : ""}/api/v1/hooks/YOUR_COMPANY/test \
                    </code>
                    <code className="bv-mono block ml-4 text-on-surface-variant">
                      -H &quot;Authorization: Bearer YOUR_TOKEN&quot; \
                    </code>
                    <code className="bv-mono block ml-4 text-on-surface-variant">
                      -H &quot;Content-Type: application/json&quot; \
                    </code>
                    <code className="bv-mono block ml-4 text-on-surface-variant">
                      -d {`'{"data": "test"}'`}
                    </code>
                  </div>
                </div>
              </ForgeSection>
            )}

            {/* ── Referral ── */}
            {active === "referral" && (
              <ForgeSection title={uiText("m0f7b30dc841a")} subtitle={uiText("mb7cd3f777bef")} icon="redeem">
                {referral ? (
                  <div className="space-y-5">
                    <div className="p-4 rounded-xl bg-primary/6 border border-primary/25">
                      <p className="bv-micro text-primary mb-2">{uiText("m5c91a47132b9")}</p>
                      <div className="flex items-center gap-3">
                        <code className="bv-numeric text-xl text-on-surface">{referral.code}</code>
                        <button
                          onClick={() => navigator.clipboard.writeText(referral.code)}
                          className="bv-btn bv-btn-primary bv-btn-sm"
                        >{uiText("mf516b06d11bf")}</button>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { label: runtimeCopy("m797c03ac6662"), value: referral.stats.totalReferred },
                        { label: runtimeCopy("ma571fa84edbc"), value: referral.stats.converted },
                        { label: runtimeCopy("m48fa986d975f"), value: referral.stats.rewardsApplied },
                      ].map((s) => (
                        <div key={s.label} className="text-center p-4 rounded-xl bv-glass">
                          <p className="bv-numeric text-2xl text-primary">{s.value}</p>
                          <p className="bv-caption mt-0.5">{s.label}</p>
                        </div>
                      ))}
                    </div>
                    <div>
                      <p className="text-sm font-medium mb-2 text-on-surface-variant">{uiText("m724c36053cc8")}</p>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={redeemCode}
                          onChange={(e) => setRedeemCode(e.target.value)}
                          placeholder={"AICOS-XXXXXXXX"}
                          className="flex-1 px-3.5 py-2.5 rounded-xl text-sm font-mono bg-surface-container border border-outline-variant/30 text-on-surface outline-none focus:border-primary/50 transition-colors"
                        />
                        <button
                          onClick={async () => {
                            if (!redeemCode.trim()) return;
                            try {
                              const res = await api.redeemReferral(token!, redeemCode.trim());
                              if (!current()) return;
                              setRedeemResult(res.reward); setRedeemCode("");
                            } catch (err) { if (current()) setRedeemResult(describeFailure(err)); }
                          }}
                          className="bv-btn bv-btn-primary"
                        >{uiText("m0a34e3a598e6")}</button>
                      </div>
                      {redeemResult && <p className="text-sm mt-2 text-primary">{redeemResult}</p>}
                    </div>
                  </div>
                ) : (
                  <p className="text-on-surface-variant bv-caption">{uiText("mc12fbd6e7a20")}</p>
                )}
              </ForgeSection>
            )}

            {/* ── Danger zone ── */}
            {active === "danger" && (
              <div className="bv-glass rounded-2xl p-6" style={{ borderColor: "rgba(255,77,77,0.3)", background: "rgba(255,77,77,0.03)" }}>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="material-symbols-outlined text-error" style={{ fontSize: 20 }}>warning</span>
                  <h2 className="bv-title font-headline font-bold uppercase text-error" style={{ fontSize: 16, letterSpacing: "0.04em" }}>{uiText("m2255caa19025")}</h2>
                </div>
                <p className="bv-caption mb-5">{uiText("mcde607c76c72")}</p>

                <div>
                  <div className="flex items-center justify-between py-3.5 border-b border-error/10">
                    <div>
                      <p className="text-sm font-medium text-on-surface">{uiText("m6efdb34e5814")}</p>
                      <p className="bv-caption mt-0.5">{uiText("m9bb76ca4a794")}</p>
                    </div>
                    <button
                      onClick={() => { void api.signOut(); router.replace("/login"); }}
                      className="bv-btn bv-btn-ghost bv-btn-sm"
                    >{uiText("m9bdeb5968503")}</button>
                  </div>
                  <div className="flex items-center justify-between py-3.5">
                    <div>
                      <p className="text-sm font-medium text-on-surface">{uiText("m7775a95698f6")}</p>
                      <p className="bv-caption mt-0.5">{uiText("me7ec08fd87b4")}</p>
                    </div>
                    <button className="bv-btn bv-btn-danger bv-btn-sm">{uiText("mb3ebf6fede5b")}</button>
                  </div>
                </div>
              </div>
            )}

          </div>{/* /section panels */}
        </div>{/* /two-col grid */}
      </div>
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────────────────── */

function ForgeSection({ title, subtitle, icon, children }: { title: string; subtitle: string; icon?: string; children: React.ReactNode }) {
  return (
    <div className="bv-glass rounded-2xl p-6 bv-rise">
      <div className="mb-5 pb-4 border-b border-outline-variant/15">
        <div className="flex items-center gap-2 mb-0.5">
          {icon && <span className="material-symbols-outlined text-primary" style={{ fontSize: 18 }}>{icon}</span>}
          <h2 className="bv-title font-headline font-bold uppercase" style={{ fontSize: 15, letterSpacing: "0.04em" }}>{title}</h2>
        </div>
        <p className="bv-caption">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function ForgeField({
  label, type = "text", placeholder, badge, value, onChange, readOnly,
}: {
  label: string; type?: string; placeholder: string; badge?: string;
  value?: string; onChange?: (v: string) => void; readOnly?: boolean;
}) {
  const fieldId = useId();
  return (
    <div>
      <label htmlFor={fieldId} className="bv-micro text-outline mb-1.5 block">{label}</label>
      <div className="relative">
        <input
          id={fieldId}
          type={type}
          placeholder={placeholder}
          value={value}
          onChange={onChange ? (e) => onChange(e.target.value) : undefined}
          readOnly={readOnly}
          className="w-full px-3.5 py-2.5 rounded-xl text-sm outline-none bg-surface-container border border-outline-variant/30 text-on-surface placeholder:text-outline focus:border-primary/50 transition-colors"
          style={readOnly ? { opacity: 0.75, cursor: "default" } : undefined}
        />
        {badge && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 bv-pill bv-pill-cyan">
            {badge}
          </span>
        )}
      </div>
    </div>
  );
}

function ForgeUsageBar({ label, current, limit }: { label: string; current: number; limit: number }) {
  const unlimited = limit < 0;
  const pct = unlimited ? 0 : Math.min(100, (current / limit) * 100);
  const danger = !unlimited && pct >= 80;
  return (
    <div>
      <div className="flex justify-between text-sm mb-1.5">
        <span className="text-on-surface-variant">{label}</span>
        <span className="font-semibold" style={{ color: danger ? "var(--color-error)" : "var(--color-on-surface)" }}>
          {current}{unlimited ? "" : ` / ${limit}`}
        </span>
      </div>
      {!unlimited && (
        <div className="h-1.5 rounded-full overflow-hidden bg-surface-container-high">
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${pct}%`,
              background: danger ? "var(--color-error)" : "var(--bv-gradient-brand)",
            }}
          />
        </div>
      )}
    </div>
  );
}

function ForgeSaveBar({ onSave, saved }: { onSave: () => void; saved: boolean }) {
  const uiText = useLegacyTranslations("uiCopy");
  return (
    <div className="flex items-center justify-end gap-3 mt-7 pt-5 border-t border-outline-variant/15">
      <button className="bv-btn bv-btn-ghost">{uiText("mef4c40cb137f")}</button>
      <button
        onClick={onSave}
        className="bv-btn bv-btn-primary"
        style={saved ? { background: "rgba(59,130,246,0.15)", boxShadow: "none", color: "var(--color-primary)" } : {}}
      >
        {saved ?uiText("m25f762b46741") :uiText("m8c8adacdb1db")}
      </button>
      {saved && (
        <span className="text-xs font-medium animate-fade-in text-primary">{uiText("m0ce1f02a34d4")}</span>
      )}
    </div>
  );
}

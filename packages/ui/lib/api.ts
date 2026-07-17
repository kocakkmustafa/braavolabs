import { useAppStore } from "./store";

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080/api/v1";

interface FetchOptions extends RequestInit {
  token?: string;
}

// ─── Session refresh on 401 ─────────────────────────────────────────
//
// Access tokens expire after 1h while the refresh token lives for days.
// Without interception every API call after the first hour throws and
// the app looks broken until the user manually re-logs. On the first
// 401 of an authenticated call we redeem the stored refresh token once
// and replay the original request with the new access token.
//
// Single-flight: the server ROTATES the refresh token on use (the old
// one is revoked), so concurrent 401s must share one in-flight refresh —
// a second redeem of the same token would 401 and log everyone out.
let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  const { refreshToken } = useAppStore.getState();
  if (!refreshToken) return null;
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      // credentials: send the httpOnly refresh cookie under AUTH_COOKIE_MODE;
      // the server falls back to it when the body omits refreshToken (which is
      // the case once the store stops persisting tokens in cookie-mode).
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    const data: {
      token: string;
      refreshToken: string;
      tenant: { id: string };
    } = await res.json();
    const { setAuth, tenantId } = useAppStore.getState();
    setAuth(data.token, data.tenant?.id ?? tenantId ?? "", data.refreshToken);
    return data.token;
  } catch {
    return null;
  }
}

function refreshOnce(): Promise<string | null> {
  refreshInFlight ??= refreshAccessToken().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

// Refresh failed (revoked / expired / Redis-down fail-closed): drop the
// dead session and send the user to /login instead of leaving them on a
// page where every request silently 401s.
function hardLogout(): void {
  useAppStore.getState().clearAuth();
  if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
    window.location.href = "/login";
  }
}

async function throwApiError(res: Response): Promise<never> {
  const body = await res.json().catch(() => ({}));
  // Server's zod errors put the actionable text in `message` ("password:
  // Password must contain uppercase, lowercase, and a number"), not in
  // the top-level `error` ("Validation failed"). Surface the most
  // specific field available so the form shows the real reason.
  const detail =
    body.message ||
    body.issues?.[0]?.message ||
    body.error ||
    `API error: ${res.status}`;
  throw new Error(detail);
}

export async function apiFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const { token, headers, ...rest } = options;

  // `rest.body` is always a string (callers JSON.stringify), so the
  // request can be safely replayed after a token refresh.
  // `credentials: "include"` sends the httpOnly access cookie the API sets
  // under AUTH_COOKIE_MODE. It's behavior-neutral today (bearer keeps priority
  // server-side, and no such cookie exists while the flag is off) and is the
  // prerequisite for the cookie-only auth migration. Placed AFTER `...rest` so
  // it's always applied.
  const doFetch = (bearer?: string) =>
    fetch(`${API_BASE}${path}`, {
      ...rest,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(bearer && { Authorization: `Bearer ${bearer}` }),
        ...headers,
      },
    });

  let res = await doFetch(token);

  // 401 on an authenticated call → try one refresh + replay. /auth/*
  // endpoints are excluded: a 401 there is a real credential failure
  // (bad password, dead refresh token), not an expired access token.
  if (res.status === 401 && token && !path.startsWith("/auth/")) {
    const newToken = await refreshOnce();
    if (!newToken) {
      hardLogout();
      throw new Error("Session expired — please sign in again.");
    }
    res = await doFetch(newToken);
    if (res.status === 401) {
      // A freshly-minted token was rejected — server-side revocation
      // (kicked from tenant, role change). Don't loop; sign out.
      hardLogout();
      throw new Error("Session expired — please sign in again.");
    }
  }

  if (!res.ok) {
    await throwApiError(res);
  }

  return res.json();
}

// Typed API helpers
export const api = {
  // Auth
  login: (email: string, password: string) =>
    apiFetch<{ token: string; user: any; tenant: any }>("/auth/login", {
      method: "POST", body: JSON.stringify({ email, password }),
    }),
  register: (data: { email: string; password: string; name: string; tenantName: string; ref?: string }) =>
    apiFetch<{ token: string; user: any; tenant: any }>("/auth/register", {
      method: "POST", body: JSON.stringify(data),
    }),
  // `credentials: "include"` — the authorize response sets an httpOnly
  // state cookie on the API origin (double-submit CSRF binding, verified
  // at the OAuth callback). The API is cross-origin but same-site
  // (api.braavolabs.com ↔ braavolabs.com), so browsers accept the cookie
  // as long as the fetch carries credentials; CORS already allows it.
  googleAuthUrl: () =>
    apiFetch<{ url: string }>("/auth/google", { credentials: "include" }),
  githubAuthUrl: () =>
    apiFetch<{ url: string }>("/auth/github", { credentials: "include" }),
  appleAuthUrl: () =>
    apiFetch<{ url: string }>("/auth/apple", { credentials: "include" }),
  forgotPassword: (email: string) =>
    apiFetch<{ message: string }>("/auth/forgot-password", {
      method: "POST", body: JSON.stringify({ email }),
    }),
  resetPassword: (token: string, password: string) =>
    apiFetch<{ message: string }>("/auth/reset-password", {
      method: "POST", body: JSON.stringify({ token, password }),
    }),

  // Pre-baked starter companies (catalog + 1-click clone). The list
  // endpoint is public — the picker on /companies/new can fetch it
  // without a token, which lets the marketing site preview templates
  // without requiring sign-up.
  starters: {
    list: () => apiFetch<{
      templates: Array<{
        id: string;
        name: string;
        tagline: string;
        emoji: string;
        description: string;
        outcome: string;
        trialCost: number;
        primitives: string[];
        agentCount: number;
        pipelineCount: number;
        pipelineSteps: number;
      }>;
    }>("/starters"),
    clone: (token: string, id: string, name?: string) =>
      apiFetch<{
        company: { id: string; slug: string; name: string };
        agentCount: number;
        pipelineCount: number;
        message: string;
      }>(`/starters/${id}/clone`, {
        method: "POST",
        token,
        body: JSON.stringify(name ? { name } : {}),
      }),
  },

  // Self-service profile + trial state. Trial block is what powers the
  // dashboard banner ("X free runs left — subscribe to keep going") so
  // the FE doesn't need to know about Groq or trial counters at all.
  users: {
    me: (token: string) => apiFetch<{
      id: string;
      email: string;
      emailVerifiedAt: string | null;
      name: string | null;
      avatarUrl: string | null;
      role: string;
      createdAt: string;
      tenant: { id: string; name: string; slug: string; plan: string };
      trial: {
        enabled: boolean;
        used: number;
        limit: number;
        remaining: number;
        exhausted: boolean;
      };
    }>("/users/me", { token }),
    updateMe: (token: string, data: { name: string }) =>
      apiFetch<{ id: string; email: string; name: string | null }>("/users/me", {
        method: "PATCH",
        body: JSON.stringify(data),
        token,
      }),
  },

  // Notification preferences (user-level; shared with the mobile app)
  getNotificationPrefs: (token: string) =>
    apiFetch<{ approvals: boolean; risks: boolean; runs: boolean; drafts: boolean }>(
      "/devices/notification-prefs",
      { token }
    ),
  updateNotificationPrefs: (
    token: string,
    data: Partial<{ approvals: boolean; risks: boolean; runs: boolean; drafts: boolean }>
  ) =>
    apiFetch<{ approvals: boolean; risks: boolean; runs: boolean; drafts: boolean }>(
      "/devices/notification-prefs",
      { method: "PATCH", body: JSON.stringify(data), token }
    ),

  // Dashboard
  health: (token: string) => apiFetch<{
    status: string; activeCompanies: number; activeRuns: number; pendingApprovals: number;
  }>("/dashboard/health", { token }),

  usage: (token: string) => apiFetch<{
    totalRuns: number; completedRuns: number; failedRuns: number; successRate: number;
  }>("/dashboard/usage", { token }),

  finance: (token: string) => apiFetch<{
    totalCostUsd: number; runCount: number; avgCostPerRun: number;
  }>("/dashboard/finance", { token }),

  // Companies
  listCompanies: (token: string) => apiFetch<any[]>("/companies", { token }),
  getCompany: (token: string, id: string) => apiFetch<any>(`/companies/${id}`, { token }),
  pauseCompany: (token: string, id: string) =>
    apiFetch<any>(`/companies/${id}/pause`, { method: "POST", token }),
  resumeCompany: (token: string, id: string) =>
    apiFetch<any>(`/companies/${id}/resume`, { method: "POST", token }),
  buildCompany: (token: string, description: string) =>
    apiFetch<any>("/companies/build", { method: "POST", body: JSON.stringify({ description }), token }),
  buildAnswer: (token: string, sessionId: string, answer: string) =>
    apiFetch<any>(`/companies/build/${sessionId}/answer`, { method: "POST", body: JSON.stringify({ answer }), token }),
  buildConfirm: (token: string, sessionId: string) =>
    apiFetch<any>(`/companies/build/${sessionId}/confirm`, { method: "POST", token }),

  // Approvals
  listApprovals: (token: string, status = "PENDING") =>
    apiFetch<any[]>(`/approvals?status=${status}`, { token }),
  // `note` is optional: for an INPUT approval (agent ask_user) an APPROVED note
  // is the answer delivered back to the agent; for SPEND it's an audit note.
  decideApproval: (token: string, id: string, decision: "APPROVED" | "REJECTED", note?: string) =>
    apiFetch<any>(`/approvals/${id}/decide`, { method: "POST", body: JSON.stringify({ decision, note }), token }),

  // Drafts
  listDrafts: (token: string, companyId: string) =>
    apiFetch<any[]>(`/drafts?companyId=${companyId}`, { token }),
  updateDraft: (token: string, id: string, data: Record<string, unknown>) =>
    apiFetch<any>(`/drafts/${id}`, { method: "PATCH", body: JSON.stringify(data), token }),

  // Runs
  getRun: (token: string, id: string) => apiFetch<any>(`/runs/${id}`, { token }),
  triggerRun: (token: string, pipelineId: string, input = {}) =>
    apiFetch<any>(`/pipelines/${pipelineId}/run`, { method: "POST", body: JSON.stringify({ input }), token }),

  // Pre-run cost ESTIMATE (range, never exact) using the tenant's configured
  // provider/model. Labelled as an estimate in the UI; live `costUsd` on the
  // run is the source of truth.
  pipelineCostEstimate: (token: string, id: string) =>
    apiFetch<{
      stepCount: number;
      provider: string;
      model: string;
      lowUsd: number;
      highUsd: number;
      perStepUsd: number;
      isEstimate: boolean;
      isFree: boolean;
      unknownModel: boolean;
      configured: boolean;
    }>(`/pipelines/${id}/cost-estimate`, { token }),

  // AI-generated plain-language explanation of a FAILED run + a suggested fix.
  // Uses the tenant's own LLM key. UI labels the result as an AI explanation.
  explainRun: (token: string, id: string) =>
    apiFetch<{
      explanation: string;
      suggestedFix: string;
      provider: string;
      model: string;
      generatedByAi: boolean;
    }>(`/runs/${id}/explain`, { method: "POST", token }),
  // Mid-run steering — inject operator guidance into a live run; the agent
  // loop drains it on its next turn.
  steerRun: (token: string, runId: string, content: string, targetAgentId?: string) =>
    apiFetch<{ success: boolean; id: string }>(`/runs/${runId}/steer`, {
      method: "POST", body: JSON.stringify({ content, targetAgentId }), token,
    }),

  // Cross-model handoff (E3/T8, plan §2.6) — the HandoffPanel on /runs/[id]
  // drives these. The provider picker is fed by listProviderLinks (the
  // key-masked LIST endpoint T5 added); startHandoff freezes the run's
  // checkpoint; continueHandoff claims the OPEN ledger for a takeover
  // provider (409 CHECKPOINT_PENDING while the live loop hasn't reached a
  // turn boundary yet — the panel surfaces "freezing…" and lets the operator
  // retry); listHandoffs powers the ledger timeline.
  listHandoffs: (token: string, runId: string) =>
    apiFetch<{
      handoffs: Array<{
        id: string;
        runId: string;
        stepIndex: number;
        status: "OPEN" | "CLAIMED" | "COMPLETED" | "FAILED" | "CANCELLED";
        reason: "MANUAL" | "PROVIDER_FAILOVER" | "PROVIDER_EXHAUSTED" | "SESSION_LOST";
        fromProvider: string;
        fromModel: string;
        toProvider: string | null;
        toModel: string | null;
        contextSummary: string | null;
        gitState: unknown | null;
        createdBy: string | null;
        claimedBy: string | null;
        createdAt: string;
        claimedAt: string | null;
        completedAt: string | null;
      }>;
    }>(`/runs/${runId}/handoffs`, { token }),
  startHandoff: (token: string, runId: string, reason?: string) =>
    apiFetch<{
      success: boolean;
      handoffId: string;
      status: string;
      checkpointPending: boolean;
    }>(`/runs/${runId}/handoff`, {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
      token,
    }),
  continueHandoff: (
    token: string,
    runId: string,
    body: { provider: string; model?: string; baseUrl?: string },
  ) =>
    apiFetch<{
      success: boolean;
      handoffId: string;
      status: string;
      toProvider: string;
      toModel: string;
    }>(`/runs/${runId}/continue`, {
      method: "POST",
      body: JSON.stringify(body),
      token,
    }),
  // Key-masked multi-BYOK provider list (T5 — GET /settings/ai-config/providers).
  // Powers the HandoffPanel takeover-provider picker. keyMasked is "••••abcd"
  // for cloud rows, null for keyless-local (Ollama/LM Studio/Custom).
  listProviderLinks: (token: string) =>
    apiFetch<{
      providers: Array<{
        provider: string;
        model: string;
        isDefault: boolean;
        fallbackOrder: number | null;
        baseUrl: string | null;
        keyMasked: string | null;
      }>;
    }>("/settings/ai-config/providers", { token }),

  // Dashboard extended
  listRuns: (token: string, limit = 50, offset = 0) =>
    apiFetch<{ runs: any[]; total: number }>(`/dashboard/runs?limit=${limit}&offset=${offset}`, { token }),
  activityLog: (token: string, limit = 50, offset = 0) =>
    apiFetch<{ logs: any[]; total: number }>(`/dashboard/activity?limit=${limit}&offset=${offset}`, { token }),
  riskEvents: (token: string, limit = 50) =>
    apiFetch<any[]>(`/dashboard/risk-events?limit=${limit}`, { token }),

  // Billing
  billingUsage: (token: string) =>
    apiFetch<{
      plan: string;
      period: { start: string; end: string };
      meters: { metric: string; value: number }[];
      live: { runs: number; toolCalls: number };
    }>("/billing/usage", { token }),
  billingSubscription: (token: string) =>
    apiFetch<{
      plan: string;
      stripeCustomerId: string | null;
      subscription: {
        id: string; status: string; currentPeriodEnd: string; cancelAtPeriodEnd: boolean;
      } | null;
    }>("/billing/subscription", { token }),
  // Backend accepts the full 5-tier set; client signature now matches.
  billingCheckout: (
    token: string,
    plan: "CREATOR" | "PRO" | "BUSINESS" | "ENTERPRISE",
    // Field name must be `billingCycle` — the API's checkout Zod schema
    // (billing/router.ts) silently defaulted `billingPeriod` to monthly.
    billingCycle: "monthly" | "yearly" = "monthly",
  ) =>
    apiFetch<{ url: string }>("/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ plan, billingCycle }),
      token,
    }),
  billingPortal: (token: string) =>
    apiFetch<{ url: string }>("/billing/portal", { method: "POST", token }),

  // Onboarding
  onboardingStatus: (token: string) =>
    apiFetch<{
      completed: boolean;
      progress: number;
      steps: Record<string, boolean>;
    }>("/onboarding/status", { token }),
  createHeroCompany: (token: string, data: { companyName?: string; niche?: string; targetAudience?: string }) =>
    apiFetch<any>("/onboarding/hero-company", { method: "POST", body: JSON.stringify(data), token }),

  // Growth & Referrals
  getReferral: (token: string) =>
    apiFetch<{
      code: string;
      stats: { totalReferred: number; converted: number; rewardsApplied: number };
      referrals: any[];
    }>("/growth/referral", { token }),
  generateReferralCode: (token: string) =>
    apiFetch<{ code: string; id: string }>("/growth/referral/generate", { method: "POST", token }),
  redeemReferral: (token: string, code: string) =>
    apiFetch<{ success: boolean; reward: string }>("/growth/referral/redeem", { method: "POST", body: JSON.stringify({ code }), token }),
  growthStats: (token: string) =>
    apiFetch<any>("/growth/stats", { token }),

  // PQL
  pqlScore: (token: string) =>
    apiFetch<any>("/growth/pql", { token }),

  // Blueprints removed (decision 2026-04-30): users now describe their
  // company end-to-end in plain English; the AI builder writes the
  // agents and pipeline from scratch. Pre-canned templates and
  // marketplace clone are intentionally gone.

  // Dashboard — agent performance
  agentPerformance: (token: string) =>
    apiFetch<{
      agents: Array<{
        agentId: string; agentName: string; role: string; companyName: string;
        totalRuns: number; completedRuns: number; failedRuns: number; successRate: number;
        totalCostUsd: number; avgCostPerRun: number; avgDurationMs: number; totalToolCalls: number;
      }>;
      toolDistribution: Array<{ toolName: string; count: number }>;
      period: { start: string; end: string };
    }>("/dashboard/agent-performance", { token }),

  // Pipeline — from natural language
  createPipelineFromNL: (token: string, companyId: string, description: string, name?: string) =>
    apiFetch<{ pipeline: any; generatedFrom: string; aiModel: string }>(
      "/pipelines/from-natural-language",
      { method: "POST", body: JSON.stringify({ companyId, description, name }), token }
    ),

  // Company — delete (archive)
  archiveCompany: (token: string, id: string) =>
    apiFetch<{ success: boolean }>(`/companies/${id}`, { method: "DELETE", token }),

  // Company — activity timeline
  companyActivity: (token: string, companyId: string, limit = 50, offset = 0) =>
    apiFetch<{ logs: any[]; total: number }>(`/companies/${companyId}/activity?limit=${limit}&offset=${offset}`, { token }),

  // Company — nested contacts & deals
  companyContacts: (token: string, companyId: string) =>
    apiFetch<any[]>(`/companies/${companyId}/contacts`, { token }),
  companyDeals: (token: string, companyId: string) =>
    apiFetch<any[]>(`/companies/${companyId}/deals`, { token }),

  // Agents CRUD
  listAgents: (token: string, companyId: string) =>
    apiFetch<any[]>(`/companies/${companyId}/agents`, { token }),
  createAgent: (token: string, companyId: string, data: { name: string; role: string; tools?: string[] }) =>
    apiFetch<any>(`/companies/${companyId}/agents`, { method: "POST", body: JSON.stringify(data), token }),
  updateAgent: (token: string, companyId: string, agentId: string, data: Record<string, unknown>) =>
    apiFetch<any>(`/companies/${companyId}/agents/${agentId}`, { method: "PATCH", body: JSON.stringify(data), token }),
  deleteAgent: (token: string, companyId: string, agentId: string) =>
    apiFetch<{ success: boolean }>(`/companies/${companyId}/agents/${agentId}`, { method: "DELETE", token }),
  composeAgent: (token: string, companyId: string, description: string) =>
    apiFetch<{
      agent: { id: string; name: string; role: string; systemPrompt: string; tools: string[] };
      droppedTools: string[];
      provider: string;
      model: string;
      tokens: { input: number; output: number };
    }>(`/companies/${companyId}/agents/compose`, {
      method: "POST", body: JSON.stringify({ description }), token,
    }),

  // Pipeline CRUD
  getPipeline: (token: string, id: string) =>
    apiFetch<any>(`/pipelines/${id}`, { token }),
  updatePipeline: (token: string, id: string, data: Record<string, unknown>) =>
    apiFetch<any>(`/pipelines/${id}`, { method: "PATCH", body: JSON.stringify(data), token }),
  deletePipeline: (token: string, id: string) =>
    apiFetch<{ success: boolean }>(`/pipelines/${id}`, { method: "DELETE", token }),

  // Pipeline revision history (D4) — prior step snapshots from activity_log.
  pipelineRevisions: (token: string, id: string) =>
    apiFetch<{
      revisions: Array<{
        id: string;
        actor: string | null;
        createdAt: string;
        stepCountBefore?: number;
        stepCountAfter?: number;
        steps: Array<{ name: string; agentRole: string; order: number }>;
      }>;
    }>(`/pipelines/${id}/revisions`, { token }),
  restorePipelineRevision: (token: string, id: string, revisionId: string) =>
    apiFetch<any>(`/pipelines/${id}/revisions/restore`, {
      method: "POST",
      body: JSON.stringify({ revisionId }),
      token,
    }),

  // Draft approve/send
  approveDraft: (token: string, id: string, send = false) =>
    apiFetch<any>(`/drafts/${id}/approve`, { method: "POST", body: JSON.stringify({ send }), token }),

  // Pipelines — list all for tenant
  listPipelines: (token: string, companyId?: string) =>
    apiFetch<any[]>(`/pipelines${companyId ? `?companyId=${companyId}` : ""}`, { token }),

  // Memory search
  searchMemory: (token: string, query: string, companyId?: string) =>
    apiFetch<any[]>("/memory/search", { method: "POST", body: JSON.stringify({ query, companyId }), token }),

  // Webhooks — list company webhooks (derived from activity log)
  companyWebhooks: (token: string, companyId: string) =>
    apiFetch<any[]>(`/companies/${companyId}/webhooks`, { token }),

  // Export
  exportBundle: (token: string, companyId: string, format = "claude-code") =>
    apiFetch<any>(`/export/${companyId}/bundle?format=${format}`, { token }),
  exportClaudeMd: (token: string, companyId: string) =>
    apiFetch<string>(`/export/${companyId}/claude-md`, { token, headers: { Accept: "text/markdown" } }),
  exportSkills: (token: string, companyId: string) =>
    apiFetch<any>(`/export/${companyId}/skills`, { token }),
  exportHooks: (token: string, companyId: string) =>
    apiFetch<any>(`/export/${companyId}/hooks`, { token }),

  // Integrations
  listProviders: (token: string) =>
    apiFetch<any[]>("/integrations/providers", { token }),
  listIntegrations: (token: string, companyId: string) =>
    apiFetch<any[]>(`/integrations/${companyId}`, { token }),
  saveIntegration: (token: string, companyId: string, provider: string, credentials: Record<string, string>, label?: string) =>
    apiFetch<any>(`/integrations/${companyId}`, { method: "POST", body: JSON.stringify({ provider, credentials, label }), token }),
  testIntegration: (token: string, companyId: string, provider: string) =>
    apiFetch<any>(`/integrations/${companyId}/test`, { method: "POST", body: JSON.stringify({ provider }), token }),
  deleteIntegration: (token: string, companyId: string, provider: string) =>
    apiFetch<any>(`/integrations/${companyId}/${provider}`, { method: "DELETE", token }),
  missingIntegrations: (token: string, companyId: string) =>
    apiFetch<any>(`/integrations/${companyId}/missing`, { token }),

  // Integration Catalog (120+ connectors)
  integrationCatalog: (token: string, category?: string, search?: string) => {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (search) params.set("search", search);
    const qs = params.toString();
    return apiFetch<any[]>(`/integrations/catalog${qs ? `?${qs}` : ""}`, { token });
  },
  integrationCatalogDetail: (token: string, id: string) =>
    apiFetch<any>(`/integrations/catalog/${id}`, { token }),

  // A/B Testing
  listAbTests: (token: string, status?: string) =>
    apiFetch<any[]>(`/ab-tests${status ? `?status=${status}` : ""}`, { token }),
  createAbTest: (token: string, data: { companyId: string; agentId: string; name: string; description?: string; variants: any[] }) =>
    apiFetch<any>("/ab-tests", { method: "POST", body: JSON.stringify(data), token }),
  getAbTest: (token: string, id: string) =>
    apiFetch<any>(`/ab-tests/${id}`, { token }),
  startAbTest: (token: string, id: string) =>
    apiFetch<any>(`/ab-tests/${id}/start`, { method: "PATCH", token }),
  pauseAbTest: (token: string, id: string) =>
    apiFetch<any>(`/ab-tests/${id}/pause`, { method: "PATCH", token }),
  completeAbTest: (token: string, id: string, winnerVariantId?: string) =>
    apiFetch<any>(`/ab-tests/${id}/complete`, { method: "PATCH", body: JSON.stringify({ winnerVariantId }), token }),
  deleteAbTest: (token: string, id: string) =>
    apiFetch<any>(`/ab-tests/${id}`, { method: "DELETE", token }),
  recordAbMetric: (token: string, testId: string, data: { variantId: string; metric: string; value: number; runId?: string }) =>
    apiFetch<any>(`/ab-tests/${testId}/metrics`, { method: "POST", body: JSON.stringify(data), token }),
  abTestResults: (token: string, id: string) =>
    apiFetch<any>(`/ab-tests/${id}/results`, { token }),
  // Apply the winning variant's config to the parent agent. Snapshots
  // the existing agent into AgentVersion first so the promotion is
  // reversible from the agent detail page.
  promoteAbTestWinner: (token: string, id: string) =>
    apiFetch<{
      success: boolean;
      agent: { id: string; name: string };
      snapshotVersion: number;
      promotedFrom: { variantId: string; variantName: string };
    }>(`/ab-tests/${id}/promote-winner`, { method: "POST", token }),

  // Agent Version Control
  listAgentVersions: (token: string, agentId: string) =>
    apiFetch<any[]>(`/agents/${agentId}/versions`, { token }),
  createAgentVersion: (token: string, agentId: string, data?: { label?: string; changeSummary?: string }) =>
    apiFetch<any>(`/agents/${agentId}/versions`, { method: "POST", body: JSON.stringify(data ?? {}), token }),
  getAgentVersion: (token: string, agentId: string, version: number) =>
    apiFetch<any>(`/agents/${agentId}/versions/${version}`, { token }),
  diffAgentVersions: (token: string, agentId: string, v1: number, v2: number) =>
    apiFetch<any>(`/agents/${agentId}/versions/${v1}/diff/${v2}`, { token }),
  rollbackAgent: (token: string, agentId: string, targetVersion: number) =>
    apiFetch<any>(`/agents/${agentId}/rollback`, { method: "POST", body: JSON.stringify({ targetVersion }), token }),

  // Natural Language Agent Editing
  nlEditPreview: (token: string, companyId: string, agentId: string, instruction: string) =>
    apiFetch<any>(`/companies/${companyId}/agents/${agentId}/nl-edit`, { method: "POST", body: JSON.stringify({ instruction }), token }),
  nlEditApply: (token: string, companyId: string, agentId: string, updatedConfig: Record<string, any>) =>
    apiFetch<any>(`/companies/${companyId}/agents/${agentId}/nl-edit/apply`, { method: "POST", body: JSON.stringify({ updatedConfig }), token }),

  // Webhook Templates
  listWebhookTemplates: (token: string, category?: string) =>
    apiFetch<any[]>(`/webhooks/templates${category ? `?category=${category}` : ""}`, { token }),
  getWebhookTemplate: (token: string, id: string) =>
    apiFetch<any>(`/webhooks/templates/${id}`, { token }),
  installWebhookTemplate: (token: string, templateId: string, data: { companyId: string; pipelineId: string }) =>
    apiFetch<any>(`/webhooks/templates/${templateId}/install`, { method: "POST", body: JSON.stringify(data), token }),

  // Settings — AI provider (BYOK)
  // The platform deliberately ships without a system Anthropic key.
  // Each tenant configures their own via Settings → AI Provider; the
  // key is stored encrypted (AES-256-GCM + scrypt). Onboarding can gate
  // the first run on hasApiKey === true.
  getAIConfig: (token: string) =>
    apiFetch<{
      provider: string | null;
      model: string | null;
      hasApiKey: boolean;
      supportedProviders: Array<{ provider: string; defaultModel: string; models: string[] }>;
    }>("/settings/ai-config", { token }),
  saveAIConfig: (
    token: string,
    data: { provider: string; model: string; apiKey: string },
  ) =>
    apiFetch<{ success: boolean }>("/settings/ai-config", {
      method: "PUT",
      body: JSON.stringify(data),
      token,
    }),
  deleteAIConfig: (token: string) =>
    apiFetch<{ success: boolean }>("/settings/ai-config", { method: "DELETE", token }),
  testAIConfig: (token: string) =>
    apiFetch<{ ok: boolean; latencyMs?: number; error?: string }>("/settings/ai-config/test", {
      method: "POST",
      token,
    }),

  // Collaboration / Presence
  collaborationPresence: (token: string) =>
    apiFetch<any[]>("/collaboration/presence", { token }),
  collaborationHeartbeat: (token: string, data: { page?: string; action?: string; userName?: string }) =>
    apiFetch<any>("/collaboration/presence/heartbeat", {
      method: "POST", body: JSON.stringify(data), token,
    }),
  collaborationRoom: (token: string, roomId: string) =>
    apiFetch<any>(`/collaboration/rooms/${encodeURIComponent(roomId)}`, { token }),
  collaborationJoinRoom: (token: string, roomId: string, userName?: string) =>
    apiFetch<any>(`/collaboration/rooms/${encodeURIComponent(roomId)}/join`, {
      method: "POST", body: JSON.stringify({ userName }), token,
    }),
  collaborationLeaveRoom: (token: string, roomId: string) =>
    apiFetch<any>(`/collaboration/rooms/${encodeURIComponent(roomId)}/leave`, {
      method: "POST", body: JSON.stringify({}), token,
    }),
  collaborationActivity: (token: string, limit = 50) =>
    apiFetch<any[]>(`/collaboration/activity?limit=${limit}`, { token }),

  // External automation importer — converts an n8n workflow / Claude
  // routine / OpenClaw bundle / MCP server / generic graph into a
  // Braavolabs Pipeline. Preview returns the would-be result without
  // persisting; commit writes the row.
  importAutomationPreview: (
    token: string,
    body: {
      source: "n8n" | "claude-automation" | "claude-code-routine" | "openclaw" | "nemoclaw" | "mcp" | "generic";
      payload: string;
      name?: string;
      companyId?: string;
    },
  ) =>
    apiFetch<{
      success: boolean;
      preview: { name: string; description?: string; steps: Array<{ id: string; type: string; config: unknown }> };
      droppedNodes: Array<{ id: string; type: string; reason: string }>;
      warnings: string[];
    }>("/automation-imports/preview", {
      method: "POST",
      body: JSON.stringify(body),
      token,
    }),
  importAutomationCommit: (
    token: string,
    body: {
      source: "n8n" | "claude-automation" | "claude-code-routine" | "openclaw" | "nemoclaw" | "mcp" | "generic";
      payload: string;
      name?: string;
      companyId?: string;
    },
  ) =>
    apiFetch<{
      success: boolean;
      pipelineId: string;
      droppedNodes: Array<{ id: string; type: string; reason: string }>;
      warnings: string[];
    }>("/automation-imports", {
      method: "POST",
      body: JSON.stringify(body),
      token,
    }),

  // Redeem the single-use code emitted by the OAuth callback. Returns
  // the full token bundle (access + refresh + user + tenant) so the
  // callback page can populate the auth store without ever seeing
  // bearer tokens in its URL bar.
  exchangeOAuthCode: (code: string) =>
    apiFetch<{
      token: string;
      refreshToken: string;
      user: { id: string; email: string; name: string | null; role: string };
      tenant: { id: string; name: string; slug: string; plan: string };
    }>("/auth/oauth/exchange", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),

  // Enterprise SSO (OIDC) — owner/admin config CRUD. Plan-gated to
  // BUSINESS+ at the API; reads pass through so downgraded tenants
  // can still see their existing config (404 if never set).
  getOidcConfig: (token: string) =>
    apiFetch<{
      issuer: string;
      clientId: string;
      redirectUri: string;
      scopes: string;
      domains: string;
      discoveryUrl: string | null;
      isActive: boolean;
      discoveredAt: string | null;
      hasSecret: boolean;
    } | null>("/sso/oidc", { token }),
  saveOidcConfig: (
    token: string,
    body: {
      issuer: string;
      clientId: string;
      clientSecret?: string;
      redirectUri: string;
      scopes?: string;
      domains?: string;
      discoveryUrl?: string;
      isActive?: boolean;
    },
  ) =>
    apiFetch<{ success: boolean }>("/sso/oidc", {
      method: "PUT",
      body: JSON.stringify(body),
      token,
    }),
  deleteOidcConfig: (token: string) =>
    apiFetch<{ success: boolean }>("/sso/oidc", { method: "DELETE", token }),

  // Month-end spend projection + budget bar (Feature 1).
  spendForecast: (token: string) =>
    apiFetch<{
      periodStart: string;
      periodEnd: string;
      currentSpendUsd: number;
      dailyAverageUsd: number;
      projectedMonthEndUsd: number;
      daysElapsed: number;
      daysRemaining: number;
      budgetUsd: number | null;
      status: "no_budget" | "under_budget" | "nearing_budget" | "over_budget";
      sparkline: Array<{ date: string; costUsd: number }>;
      topToolsByCost: Array<{ toolName: string; costUsd: number; callCount: number }>;
    }>("/billing/forecast", { token }),

  // Set or clear the monthly LLM/integration budget cap. Pass null to
  // clear (back to informational-only mode).
  setMonthlyBudget: (token: string, monthlyBudgetUsd: number | null) =>
    apiFetch<{ success: boolean; monthlyBudgetUsd: number | null }>(
      "/billing/budget",
      {
        method: "PATCH",
        body: JSON.stringify({ monthlyBudgetUsd }),
        token,
      },
    ),

  // External automation connections — connect & monitor an existing
  // n8n / Make / Zapier instance; the backend poller mirrors its executions.
  listExternalConnections: (token: string) =>
    apiFetch<any[]>("/external-connections", { token }),
  createExternalConnection: (
    token: string,
    body: { platform: string; label: string; baseUrl: string; apiKey: string; companyId?: string; pollIntervalSec?: number },
  ) =>
    // F3: response carries the live-validation outcome alongside the row so the
    // UI can confirm the credential actually reached the platform on connect.
    apiFetch<{
      id: string;
      status: string;
      validated: boolean;
      validationError?: string;
      recentRuns?: number;
      [k: string]: unknown;
    }>("/external-connections", { method: "POST", body: JSON.stringify(body), token }),
  patchExternalConnection: (token: string, id: string, patch: { enabled?: boolean; pollIntervalSec?: number; label?: string }) =>
    apiFetch<any>(`/external-connections/${id}`, { method: "PATCH", body: JSON.stringify(patch), token }),
  deleteExternalConnection: (token: string, id: string) =>
    apiFetch<{ success: boolean }>(`/external-connections/${id}`, { method: "DELETE", token }),
  pollExternalConnection: (token: string, id: string) =>
    apiFetch<any>(`/external-connections/${id}/poll`, { method: "POST", token }),
  externalRuns: (token: string, id: string) =>
    apiFetch<any[]>(`/external-connections/${id}/runs`, { token }),
  // Control plane — discover the platform's automations and act on them
  // (trigger / pause / resume). Capabilities ride along on the list response.
  discoverExternalWorkflows: (token: string, id: string) =>
    apiFetch<{ id: string; name: string; active?: boolean }[]>(
      `/external-connections/${id}/workflows`,
      { token },
    ),
  controlExternalConnection: (
    token: string,
    id: string,
    body: { type: "TRIGGER" | "PAUSE" | "RESUME" | "STOP"; targetId: string },
  ) =>
    apiFetch<{ ok: boolean; detail?: string }>(`/external-connections/${id}/control`, {
      method: "POST",
      body: JSON.stringify(body),
      token,
    }),
};

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080/api/v1";

interface FetchOptions extends RequestInit {
  token?: string;
}

export async function apiFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const { token, headers, ...rest } = options;

  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    ...rest,
  });

  if (!res.ok) {
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
  googleAuthUrl: () =>
    apiFetch<{ url: string }>("/auth/google"),
  githubAuthUrl: () =>
    apiFetch<{ url: string }>("/auth/github"),
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
  },

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
  buildCompany: (token: string, description: string) =>
    apiFetch<any>("/companies/build", { method: "POST", body: JSON.stringify({ description }), token }),
  buildAnswer: (token: string, sessionId: string, answer: string) =>
    apiFetch<any>(`/companies/build/${sessionId}/answer`, { method: "POST", body: JSON.stringify({ answer }), token }),
  buildConfirm: (token: string, sessionId: string) =>
    apiFetch<any>(`/companies/build/${sessionId}/confirm`, { method: "POST", token }),

  // Approvals
  listApprovals: (token: string, status = "PENDING") =>
    apiFetch<any[]>(`/approvals?status=${status}`, { token }),
  decideApproval: (token: string, id: string, decision: "APPROVED" | "REJECTED") =>
    apiFetch<any>(`/approvals/${id}/decide`, { method: "POST", body: JSON.stringify({ decision }), token }),

  // Drafts
  listDrafts: (token: string, companyId: string) =>
    apiFetch<any[]>(`/drafts?companyId=${companyId}`, { token }),
  updateDraft: (token: string, id: string, data: Record<string, unknown>) =>
    apiFetch<any>(`/drafts/${id}`, { method: "PATCH", body: JSON.stringify(data), token }),

  // Runs
  getRun: (token: string, id: string) => apiFetch<any>(`/runs/${id}`, { token }),
  triggerRun: (token: string, pipelineId: string, input = {}) =>
    apiFetch<any>(`/pipelines/${pipelineId}/run`, { method: "POST", body: JSON.stringify({ input }), token }),

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
    billingPeriod: "monthly" | "yearly" = "monthly",
  ) =>
    apiFetch<{ url: string }>("/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ plan, billingPeriod }),
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
};

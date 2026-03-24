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
    throw new Error(body.error ?? `API error: ${res.status}`);
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
  billingCheckout: (token: string, plan: "PRO" | "ENTERPRISE") =>
    apiFetch<{ url: string }>("/billing/checkout", { method: "POST", body: JSON.stringify({ plan }), token }),
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

  // Blueprints
  listBlueprints: (token: string) =>
    apiFetch<any[]>("/growth/blueprints", { token }),
  getBlueprint: (token: string, slug: string) =>
    apiFetch<any>(`/growth/blueprint/${slug}`, { token }),
  publishBlueprint: (token: string, companyId: string, data: { title?: string; description?: string; isPublic?: boolean }) =>
    apiFetch<any>("/growth/blueprint/publish", { method: "POST", body: JSON.stringify({ companyId, ...data }), token }),
  cloneBlueprint: (token: string, slug: string, name?: string) =>
    apiFetch<any>(`/growth/blueprint/${slug}/clone`, { method: "POST", body: JSON.stringify({ name }), token }),

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
};

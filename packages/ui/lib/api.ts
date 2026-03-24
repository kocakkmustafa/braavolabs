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
};

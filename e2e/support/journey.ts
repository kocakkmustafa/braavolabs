import { execFileSync } from "node:child_process";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { API, registerViaApi } from "../helpers";
import { API_ORIGIN, FAKE_LLM_BASE_URL, UI } from "../ports";

/**
 * Journey helpers for the fake-LLM reference specs (BRA-P0-10).
 * Everything goes through the REAL API; the only test-state shortcut is the
 * tenant plan (see `upgradeTenantPlan`).
 */

const DB =
  process.env.E2E_DATABASE_URL ??
  `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/aicos_e2e`;

export interface Tenant {
  token: string;
  tenantId: string;
  headers: { Authorization: string };
}

function tenantIdFromJwt(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { tenantId?: string };
  if (!payload.tenantId || !/^[\w-]+$/.test(payload.tenantId)) throw new Error("JWT carries no usable tenantId");
  return payload.tenantId;
}

/**
 * A fresh tenant is MANUAL_REVIEW: 0 companies and no self-hosted LLM provider
 * (billing gate). The product path to a paid plan is Stripe/IAP, which has no
 * offline test mode, so the journey flips the throwaway tenant's plan row
 * directly. TEST-STATE setup only; the gates themselves are untouched.
 */
export function upgradeTenantPlan(tenantId: string, plan: "TEAM" | "INDIVIDUAL" = "TEAM"): void {
  execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-q", "-c", `UPDATE tenants SET plan = '${plan}' WHERE id = '${tenantId}'`], {
    stdio: "pipe",
  });
}

/** Unique tenant on the TEAM plan, ready for a CUSTOM provider. */
export async function newPaidTenant(request: APIRequestContext): Promise<Tenant> {
  const { token } = await registerViaApi(request);
  const tenantId = tenantIdFromJwt(token);
  upgradeTenantPlan(tenantId);
  return { token, tenantId, headers: { Authorization: `Bearer ${token}` } };
}

/** Settings -> AI Provider: CUSTOM provider pointed at the fake LLM (PUT /settings/ai-config). */
export async function useFakeLlmProvider(request: APIRequestContext, t: Tenant): Promise<void> {
  const res = await request.put(`${API}/settings/ai-config`, {
    headers: t.headers,
    data: { provider: "CUSTOM", model: "e2e-fake-model", baseUrl: FAKE_LLM_BASE_URL },
    failOnStatusCode: false,
  });
  if (res.status() !== 200) throw new Error(`ai-config failed (${res.status()}): ${await res.text()}`);
}

async function postJson<T>(request: APIRequestContext, t: Tenant, path: string, data: unknown, label: string): Promise<T> {
  const res = await request.post(`${API}${path}`, { headers: t.headers, data, failOnStatusCode: false });
  if (res.status() !== 201 && res.status() !== 200) throw new Error(`${label} failed (${res.status()}): ${await res.text()}`);
  return (await res.json()) as T;
}

export async function createCompany(request: APIRequestContext, t: Tenant): Promise<{ id: string }> {
  const slug = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return postJson(request, t, "/companies", { name: `E2E ${slug}`, slug, primitives: ["CONTENT"] }, "create company");
}

export async function createAgent(
  request: APIRequestContext, t: Tenant, companyId: string,
  a: { name: string; role: string; systemPrompt: string; tools?: string[] },
): Promise<{ id: string }> {
  return postJson(request, t, `/companies/${companyId}/agents`, { ...a, tools: a.tools ?? [] }, "create agent");
}

export async function createPipeline(
  request: APIRequestContext, t: Tenant, companyId: string, agentRole: string,
): Promise<{ id: string }> {
  return postJson(request, t, "/pipelines", {
    companyId, name: "E2E pipeline", trigger: "MANUAL",
    steps: [{ name: "E2E step", agentRole, order: 0 }],
  }, "create pipeline");
}

export async function startRun(
  request: APIRequestContext, t: Tenant, pipelineId: string, input: Record<string, unknown> = {},
): Promise<{ id: string }> {
  return postJson(request, t, `/pipelines/${pipelineId}/run`, { input }, "start run");
}

export interface RunDetail {
  id: string;
  status: string;
  error?: string | null;
  steps: Array<{
    id: string; status: string; output: unknown; reasoning: string; error?: string | null;
    toolCalls: Array<{ toolName: string; status: string; error?: string | null }>;
  }>;
}

export async function getRun(request: APIRequestContext, t: Tenant, runId: string): Promise<RunDetail> {
  const res = await request.get(`${API}/runs/${runId}`, { headers: t.headers });
  return (await res.json()) as RunDetail;
}

/** Poll the run until its status is one of `statuses` (deterministic fake model: seconds, not minutes). */
export async function waitForRun(
  request: APIRequestContext, t: Tenant, runId: string, statuses: string[], timeoutMs = 45_000,
): Promise<RunDetail> {
  const deadline = Date.now() + timeoutMs;
  let last: RunDetail | undefined;
  while (Date.now() < deadline) {
    last = await getRun(request, t, runId);
    if (statuses.includes(last.status)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`run ${runId} did not reach ${statuses.join("|")} in ${timeoutMs}ms; last=${JSON.stringify(last)?.slice(0, 600)}`);
}

/**
 * Let the browser talk to the REAL API. The UI is built with
 * NEXT_PUBLIC_API_URL=https://api.operator.example/..., which does not resolve;
 * forward those calls to the loopback API and add the CORS headers the browser needs.
 */
export async function proxyBrowserApiToRealApi(context: BrowserContext, page: Page, request: APIRequestContext, token: string): Promise<void> {
  const cors = {
    "Access-Control-Allow-Origin": UI,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Requested-With",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  };
  // The UI middleware only serves the operator surface for https-forwarded requests.
  await page.setExtraHTTPHeaders({ "X-Forwarded-Proto": "https" });
  await context.addInitScript((tok: string) => {
    localStorage.setItem("cookie_consent", "essential-only");
    localStorage.setItem("aicos-auth", JSON.stringify({
      state: { token: tok, refreshToken: null, tenantId: "e2e", theme: "dark" },
      version: 0,
    }));
  }, token);
  await context.route(/https:\/\/api\.operator\.example\/api\/v1\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    // SSE would never finish through a buffered proxy; the pages fall back to polling.
    if (url.pathname.endsWith("/stream")) return route.abort();
    try {
      const real = await request.fetch(`${API_ORIGIN}${url.pathname}${url.search}`, {
        method: req.method(),
        headers: { Authorization: `Bearer ${token}`, ...(req.postData() ? { "Content-Type": "application/json" } : {}) },
        data: req.postDataBuffer() ?? undefined,
        failOnStatusCode: false,
      });
      return route.fulfill({
        status: real.status(), headers: { ...cors, "content-type": "application/json" }, body: await real.body(),
      });
    } catch {
      // Page navigated away / context closed mid-flight: nothing to deliver.
      return route.abort().catch(() => undefined);
    }
  });
}

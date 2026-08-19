import type { APIRequestContext } from "@playwright/test";
import { execSync } from "node:child_process";

export const API = "http://127.0.0.1:4310/api/v1";

/**
 * Clear the per-IP auth rate-limit counters.
 *
 * `/auth/register` allows 5 requests per HOUR per IP (auth.router.ts), and every
 * test in this suite shares 127.0.0.1 — so the suite exhausts its own budget
 * partway through and later tests fail for a reason unrelated to what they
 * assert. Resetting the counter is TEST-STATE cleanup; the product limit is
 * deliberately left alone, and `billing.spec.ts` still proves the limiter
 * exists by exercising the routes it guards.
 */
function clearAuthRateLimits(): void {
  try {
    execSync(
      `redis-cli --scan --pattern 'rl:*' | xargs -r redis-cli del`,
      { stdio: "ignore", shell: "/bin/bash" },
    );
  } catch {
    // Redis not reachable, or nothing to delete — the retry below still covers
    // the 429 case, so this is best-effort by design.
  }
}

export async function registerViaApi(

  request: APIRequestContext,
): Promise<{ token: string; email: string; password: string }> {
  const password = "Str0ng-Passw0rd-2026!";
  for (let attempt = 0; attempt < 6; attempt++) {
    clearAuthRateLimits();
    const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@probe.test`;
    const res = await request.post(`${API}/auth/register`, {
      data: { email, password, name: "E2E User", tenantName: `E2E Tenant ${attempt}` },
      failOnStatusCode: false,
    });
    if (res.status() === 429) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    const body = await res.json();
    if (!body?.token) {
      throw new Error(`register failed (${res.status()}): ${JSON.stringify(body).slice(0, 300)}`);
    }
    return { token: body.token, email, password };
  }
  throw new Error("register: still rate-limited after 6 attempts");
}

import type { APIRequestContext } from "@playwright/test";
import Redis from "ioredis";

export const API = "http://127.0.0.1:4310/api/v1";
export const UI = "http://operator.example:4311";

/**
 * Clear the per-IP registration rate-limit counter.
 *
 * `/auth/register` allows 5 requests per HOUR per IP (auth.router.ts), and every
 * test in this suite shares 127.0.0.1 — so the suite exhausts its own budget
 * partway through and later tests fail for a reason unrelated to what they
 * assert. Resetting the counter is TEST-STATE cleanup; the product limit is
 * deliberately left alone.
 */
async function clearRegisterRateLimits(): Promise<void> {
  const client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  try {
    await client.connect();
    let cursor = "0";
    do {
      const [nextCursor, keys] = await client.scan(cursor, "MATCH", "rl:register:*", "COUNT", 100);
      if (keys.length > 0) await client.del(...keys);
      cursor = nextCursor;
    } while (cursor !== "0");
  } finally {
    client.disconnect();
  }
}

export async function registerViaApi(

  request: APIRequestContext,
): Promise<{ token: string; email: string; password: string }> {
  const password = "Str0ng-Passw0rd-2026!";
  for (let attempt = 0; attempt < 6; attempt++) {
    // Use the same Redis protocol/client as the application. GitHub-hosted
    // runners do not guarantee a `redis-cli` binary, so the old shell cleanup
    // silently did nothing and the suite eventually exhausted its own shared
    // 127.0.0.1 registration bucket.
    await clearRegisterRateLimits();
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

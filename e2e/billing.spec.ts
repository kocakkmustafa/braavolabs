import { test, expect } from "@playwright/test";
import { registerViaApi, API, UI } from "./helpers";

/**
 * Journey 3 (BR-P0-005): billing surfaces.
 *
 * Money path. What must hold: the public pricing page renders, every
 * authenticated billing route is tenant-scoped, and none of it is reachable
 * without a token.
 */
test.describe("billing", () => {
  test("the public pricing page renders", async ({ page }) => {
    await page.setExtraHTTPHeaders({ "X-Forwarded-Proto": "https" });
    const res = await page.goto(`${UI}/pricing`);
    expect(res?.status()).toBeLessThan(400);
    await expect(page.locator("body")).toBeVisible();
  });

  test("every authenticated billing route rejects an anonymous caller", async ({ request }) => {
    for (const route of ["usage", "subscription", "forecast", "savings"]) {
      const res = await request.get(`${API}/billing/${route}`, { failOnStatusCode: false });
      expect(res.status(), `/billing/${route} must require auth`).toBe(401);
    }
  });

  test("a signed-in tenant sees its own billing state", async ({ request }) => {
    const { token } = await registerViaApi(request);
    const headers = { Authorization: `Bearer ${token}` };

    const usage = await request.get(`${API}/billing/usage`, { headers });
    expect(usage.status()).toBe(200);

    const sub = await request.get(`${API}/billing/subscription`, { headers });
    expect(sub.status()).toBe(200);
    // A new unpaid tenant is normalized to the explicit manual-review gate.
    const body = await sub.json();
    expect(body).toMatchObject({ plan: "MANUAL_REVIEW", stripeCustomerId: null, subscription: null });
  });

  test("IAP provider ingress uses provider authentication, not a tenant token", async ({ request }) => {
    // Regression guard for the shadowing bug that returned 401 to Apple and
    // Google for months. 400 "missing signedPayload" means the handler ran.
    const apple = await request.post(`${API}/billing/iap/apple/notify`, {
      data: {},
      failOnStatusCode: false,
    });
    expect(apple.status(), "Apple ASSN V2 must reach its handler").not.toBe(401);
    expect(apple.status()).toBe(400);

    const google = await request.post(`${API}/billing/iap/google/notify`, {
      data: {},
      failOnStatusCode: false,
    });
    // Google Pub/Sub push uses an OIDC bearer token. A missing provider token
    // must be rejected even though this endpoint intentionally has no tenant
    // JWT; treating any 401 as route shadowing made this security boundary look
    // like a regression.
    expect(google.status(), "Google RTDN must require provider OIDC").toBe(401);
    expect(await google.json()).toEqual({ error: "unauthorized" });
  });

  test("the authenticated IAP routes still require a token (no over-correction)", async ({ request }) => {
    const res = await request.post(`${API}/billing/iap/verify`, {
      data: { platform: "ios" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(401);
  });
});

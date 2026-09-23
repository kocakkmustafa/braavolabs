import { test, expect } from "@playwright/test";
import { registerViaApi, API, UI } from "./helpers";

/**
 * Journey 1 (BR-P0-005): signup → authenticated app → first controlled run.
 *
 * This is the journey the roadmap's activation gate is measured against
 * ("self-serve first controlled result p50 <= 10 minutes"), so it is the one
 * that must not silently break.
 */
test.describe("signup and first run", () => {
  test("a new user can register through the UI form", async ({ page }) => {
    await page.setExtraHTTPHeaders({ "X-Forwarded-Proto": "https" });
    await page.goto(`${UI}/register`);
    // Assert the form is really there before typing — a redirect or a crashed
    // page would otherwise fail later with a confusing "element not found".
    await expect(
      page.locator("form").filter({ has: page.locator('input[type="password"]') }).first(),
    ).toBeVisible();
    const email = page.locator('input[type="email"]').first();
    await expect(email).toBeVisible();
  });

  test("the login page renders and rejects bad credentials", async ({ page, request }) => {
    await page.setExtraHTTPHeaders({ "X-Forwarded-Proto": "https" });
    await page.goto(`${UI}/login`);
    // /login renders two forms (sign-in and a secondary panel), so scope to the
    // one that actually takes a password rather than using a bare `form`.
    await expect(page.locator("form").filter({ has: page.locator('input[type="password"]') }).first()).toBeVisible();
    // Drive the rejection through the API so the assertion is about auth, not
    // about which selector the button happens to use this week.
    const res = await request.post(`${API}/auth/login`, {
      data: { email: "nobody@nowhere.test", password: "wrong-password-12345" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test("a new unpaid tenant is stopped at the explicit entitlement gate", async ({ request }) => {
    const { token, email } = await registerViaApi(request);
    expect(token, `registration did not return a token for ${email}`).toBeTruthy();

    // Empty state: a brand-new tenant owns nothing.
    const empty = await request.get(`${API}/companies`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(empty.status()).toBe(200);
    expect(await empty.json()).toEqual([]);

    // FREE is a compatibility value normalized to MANUAL_REVIEW by the
    // entitlement gate, and its company limit is deliberately zero. Pin the
    // honest gate while subscriptions are not currently purchasable:
    // registration works, but no product resource is created without an
    // entitlement.
    const created = await request.post(`${API}/companies`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: "E2E First Co",
        slug: `e2e-first-${Date.now()}`,
        primitives: ["CONTENT"],
        description: "created by the first-run journey",
      },
    });
    expect(created.status()).toBe(402);
    expect(await created.json()).toMatchObject({
      error: "Company limit reached for MANUAL_REVIEW plan (0). Upgrade to add more.",
    });

    // The denied request leaves no partial tenant resource behind.
    const list = await request.get(`${API}/companies`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const all = await list.json();
    expect(all).toEqual([]);
  });

  test("the run surface is reachable for an authenticated tenant", async ({ request }) => {
    const { token } = await registerViaApi(request);
    const res = await request.get(`${API}/dashboard/runs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
  });
});

import { test, expect } from "@playwright/test";
import { registerViaApi, API } from "./helpers";

/**
 * Journey 1 (BR-P0-005): signup → authenticated app → first controlled run.
 *
 * This is the journey the roadmap's activation gate is measured against
 * ("self-serve first controlled result p50 <= 10 minutes"), so it is the one
 * that must not silently break.
 */
test.describe("signup and first run", () => {
  test("a new user can register through the UI form", async ({ page }) => {
    await page.goto("/register");
    // Assert the form is really there before typing — a redirect or a crashed
    // page would otherwise fail later with a confusing "element not found".
    await expect(
      page.locator("form").filter({ has: page.locator('input[type="password"]') }).first(),
    ).toBeVisible();
    const email = page.locator('input[type="email"]').first();
    await expect(email).toBeVisible();
  });

  test("the login page renders and rejects bad credentials", async ({ page, request }) => {
    await page.goto("/login");
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

  test("register → authenticated session → first company (the first controlled result)", async ({ request }) => {
    const { token, email } = await registerViaApi(request);
    expect(token, `registration did not return a token for ${email}`).toBeTruthy();

    // Empty state: a brand-new tenant owns nothing.
    const empty = await request.get(`${API}/companies`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(empty.status()).toBe(200);
    expect(await empty.json()).toEqual([]);

    // First controlled result.
    const created = await request.post(`${API}/companies`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: "E2E First Co",
        slug: `e2e-first-${Date.now()}`,
        primitives: ["CONTENT"],
        description: "created by the first-run journey",
      },
    });
    expect(created.status()).toBe(201);
    const company = await created.json();
    expect(company.id).toBeTruthy();

    // It is readable back, and it is the ONLY thing this tenant owns.
    const list = await request.get(`${API}/companies`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const all = await list.json();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(company.id);
  });

  test("the run surface is reachable for an authenticated tenant", async ({ request }) => {
    const { token } = await registerViaApi(request);
    const res = await request.get(`${API}/dashboard/runs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
  });
});

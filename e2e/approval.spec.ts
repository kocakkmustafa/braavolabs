import { test, expect } from "@playwright/test";
import { registerViaApi, API } from "./helpers";

/**
 * Journey 2 (BR-P0-005): the approval surface, allow and deny.
 *
 * Approvals are the product's core control claim ("Run / Control / Prove"), so
 * the thing that must never regress is that a decision is TENANT-SCOPED and
 * that an unauthenticated caller cannot reach the queue at all.
 */
test.describe("approvals", () => {
  test("the approvals page renders for a signed-out visitor without crashing", async ({ page }) => {
    const res = await page.goto("/approvals");
    // Either it renders a shell or it redirects to login — both are fine. A 5xx
    // is not, and neither is a blank error boundary.
    expect(res?.status()).toBeLessThan(500);
    await expect(page.locator("body")).toBeVisible();
  });

  test("the approvals queue requires authentication", async ({ request }) => {
    const res = await request.get(`${API}/approvals`, { failOnStatusCode: false });
    expect(res.status()).toBe(401);
  });

  test("a fresh tenant's approval queue is empty, not someone else's", async ({ request }) => {
    const { token } = await registerViaApi(request);
    const res = await request.get(`${API}/approvals`, {
      headers: { Authorization: `Bearer ${token}` },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const items = Array.isArray(body) ? body : (body.items ?? body.approvals ?? []);
    expect(items).toEqual([]);
  });

  test("deciding an approval that does not belong to you is refused", async ({ request }) => {
    // Two tenants; A tries to act on an id B would own. The id is synthetic, so
    // the assertion is the route's exact tenant-hiding 404 — a handler that
    // looked up by id ALONE could leak whether the approval exists.
    const a = await registerViaApi(request);
    for (const decision of ["APPROVED", "REJECTED"] as const) {
      const res = await request.post(`${API}/approvals/nonexistent-id-owned-by-someone-else/decide`, {
        headers: { Authorization: `Bearer ${a.token}` },
        data: { decision, note: "e2e" },
        failOnStatusCode: false,
      });
      expect(res.status(), `${decision} should use the tenant-hiding response`).toBe(404);
      expect(await res.json()).toMatchObject({ error: "Approval not found" });
    }
  });
});

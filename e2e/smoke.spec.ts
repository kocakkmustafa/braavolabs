import { test, expect } from "@playwright/test";
import { UI } from "./helpers";

/**
 * Harness smoke test.
 *
 * Proves the two webServers in playwright.config.ts actually came up and the
 * browser can reach the UI. Kept separate from the journeys so that when a
 * journey fails you can tell "the app is broken" from "the harness never
 * started" — the single most common way an E2E suite wastes an afternoon.
 */
test("the API is reachable and healthy", async ({ request }) => {
  const res = await request.get("http://127.0.0.1:4310/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ status: "ok" });
});

test("the UI serves the landing page", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "X-Forwarded-Proto": "https" });
  const res = await page.goto(`${UI}/`);
  expect(res?.status()).toBeLessThan(400);
  await expect(page.locator("body")).toBeVisible();
});

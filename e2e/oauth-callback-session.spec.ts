import { test, expect } from "@playwright/test";
import { UI as OPERATOR_UI } from "./ports";

const UI = process.env.E2E_OAUTH_UI_URL ?? OPERATOR_UI;
const API = "https://api.operator.example";

for (const status of [200, 401]) {
  test(`OAuth callback retains a delayed ${status} exchange after URL scrub`, async ({ context, page }) => {
    let exchanges = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const token = `synthetic.${Buffer.from(JSON.stringify({ tenantId: "synthetic-tenant", exp: 4_000_000_000 })).toString("base64url")}.signature`;
    await page.setExtraHTTPHeaders({ "X-Forwarded-Proto": "https" });
    await context.addInitScript(() => localStorage.setItem("cookie_consent", "essential-only"));
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === API) {
        const headers = {
          "Access-Control-Allow-Origin": UI,
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
        };
        if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
        if (url.pathname === "/api/v1/auth/oauth/exchange") {
          exchanges++;
          expect(request.postDataJSON()).toEqual({ code: "synthetic-one-use-code" });
          await pending;
          return route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(status === 200 ? {
            token, refreshToken: "synthetic-refresh", user: { id: "synthetic-user", email: "synthetic@example.test", name: "Synthetic" },
            tenant: { id: "synthetic-tenant", name: "Synthetic", slug: "synthetic", plan: "FREE" },
          } : { message: "Synthetic expired exchange" }) });
        }
        return route.fulfill({ status: 200, headers, contentType: "application/json", body: "[]" });
      }
      if (url.origin === UI) return route.continue();
      return route.abort();
    });
    try {
      await page.goto(`${UI}/auth/callback?code=synthetic-one-use-code`, { waitUntil: "domcontentloaded" });
      await expect.poll(() => exchanges).toBe(1);
      await expect(page).toHaveURL(`${UI}/auth/callback`);
      await expect(page.getByText("Forging your session", { exact: true })).toBeVisible();
      // A render after URL scrub must still wait for the same single exchange.
      await page.waitForTimeout(100);
      expect(exchanges).toBe(1);
      release();
      await expect(page).toHaveURL(`${UI}/${status === 200 ? "dashboard" : "login"}`);
      const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem("aicos-auth") ?? "{}").state);
      if (status === 200) {
        expect(persisted).toMatchObject({ token, tenantId: "synthetic-tenant", refreshToken: "synthetic-refresh" });
      } else {
        expect(persisted?.token ?? null).toBeNull();
      }
      expect(exchanges).toBe(1);
    } finally {
      release();
    }
  });
}

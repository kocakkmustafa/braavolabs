import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { API_ORIGIN, UI } from "./ports";

// /status probes `${NEXT_PUBLIC_API_URL}/health` from the browser. The public CSP
// must admit exactly that HTTPS API origin (not its websocket, not anything else).
// The harness API listens on loopback without TLS, so the browser request to the
// configured https://api.operator.example origin is answered by the REAL local API.
const API_HEALTH = "https://api.operator.example/api/v1/health";
const copy = JSON.parse(readFileSync(join(process.cwd(), "packages/ui/messages/en.json"), "utf8")).static.status;

test("public /status reaches the real API health endpoint through the public CSP", async ({ context, page }) => {
  await context.addInitScript(() => localStorage.setItem("cookie_consent", "essential-only"));
  await page.setExtraHTTPHeaders({ "X-Forwarded-Proto": "https" });
  const probes: number[] = [];
  const cspErrors: string[] = [];
  await context.route(API_HEALTH, async (route) => {
    const response = await route.fetch({ url: `${API_ORIGIN}/api/v1/health` });
    probes.push(response.status());
    await route.fulfill({ response, headers: { ...response.headers(), "access-control-allow-origin": UI } });
  });
  page.on("console", (message) => { if (/Content Security Policy/i.test(message.text())) cspErrors.push(message.text()); });

  const response = await page.goto(`${UI}/status`);
  expect(response?.status()).toBe(200);
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("connect-src 'self' https://api.operator.example https://cloudflareinsights.com https://plausible.io");
  expect(csp).not.toContain("wss://");

  await expect(page.getByText(copy.title, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(copy.operational, { exact: true }).first()).toBeVisible();
  expect(probes.length).toBeGreaterThan(0);
  expect(probes.every((status) => status === 200)).toBe(true);
  expect(cspErrors).toEqual([]);

  // Negative: the same policy still blocks every other origin, and the API's
  // websocket origin, before any request leaves the page.
  for (const url of ["https://blocked.example/probe", "wss://api.operator.example/socket"]) {
    const violation = await page.evaluate((target) => new Promise<string | null>((resolve) => {
      document.addEventListener("securitypolicyviolation", (event) => resolve(event.effectiveDirective), { once: true });
      if (target.startsWith("wss:")) { try { new WebSocket(target); } catch { /* CSP throws or reports */ } }
      else fetch(target).catch(() => undefined);
      setTimeout(() => resolve(null), 3000);
    }), url);
    expect(violation, url).toBe("connect-src");
  }
});

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";

// Hosted harness only. Do not call registration helpers or touch its database:
// every auth endpoint is blocked unless a test provides a synthetic response.
const UI = "http://operator.example:4311";
const LOCALES = ["en", "tr", "es", "de", "fr", "ar"];
const messagesFor = (locale: string) => JSON.parse(readFileSync(
  join(process.cwd(), "packages/ui/messages", `${locale}.json`), "utf8",
));

test.beforeEach(async ({ context, page }) => {
  await context.route(/\/api\/v1\/auth\//, (route) => route.abort());
  // Consent fixture belongs only to the isolated browser context, not auth.
  await context.addInitScript(() => localStorage.setItem("cookie_consent", "essential-only"));
  await page.setExtraHTTPHeaders({ "X-Forwarded-Proto": "https" });
  await page.emulateMedia({ reducedMotion: "reduce" });
});

async function expectUnclipped(page: Page) {
  const documentGeometry = await page.evaluate(() => ({
    viewportWidth: innerWidth,
    document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
    body: { clientWidth: document.body.clientWidth, scrollWidth: document.body.scrollWidth },
  }));
  for (const element of [documentGeometry.document, documentGeometry.body]) {
    expect(element.scrollWidth, JSON.stringify(documentGeometry)).toBeLessThanOrEqual(documentGeometry.viewportWidth + 1);
  }
  const clipped = await page.locator("main input, main button, main select, main summary, main h1, main .bv-glass").evaluateAll((nodes) =>
    nodes.filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 &&
        (rect.left < -1 || rect.right > innerWidth + 1 || node.scrollWidth > node.clientWidth + 1);
    }).map((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const before = getComputedStyle(node, "::before");
      return {
        tag: node.tagName, text: node.textContent?.slice(0, 80),
        left: rect.left, right: rect.right, width: rect.width, height: rect.height,
        viewportWidth: innerWidth, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth,
        direction: style.direction, opacity: style.opacity,
        before: { content: before.content, transform: before.transform, animation: before.animationName },
      };
    }),
  );
  expect(clipped).toEqual([]);
}

async function expectKeyboardSkipLink(page: Page, locale: string) {
  const skipLink = page.locator("a.skip-link");
  await expect(skipLink).toHaveCount(1);
  await expect(skipLink).toHaveAccessibleName(messagesFor(locale).static.common.skipToMainContent);
  // Start from a fresh navigation: this must be the first keyboard stop.
  await page.keyboard.press("Tab");
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();
  await expect(skipLink).toHaveCSS("opacity", "1");
  await expect(skipLink).toHaveCSS("clip-path", "none");
  await expect(skipLink).toHaveCSS("overflow", "visible");
  const geometry = await skipLink.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  expect(geometry.left, JSON.stringify(geometry)).toBeGreaterThanOrEqual(0);
  expect(geometry.right, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.top, JSON.stringify(geometry)).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.viewportHeight);
  await expect(skipLink).toHaveAttribute("href", "#main-content");
  const main = page.locator("main#main-content");
  await expect(main).toHaveCount(1);
  await expect(main).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main-content$/);
  await expect(main).toBeFocused();
}

async function expectPaintedAuthSubmit(page: Page) {
  const submit = page.locator('form:has(input[type="password"]) button[type="submit"]');
  await expect(submit).toBeVisible();
  // Playwright visibility/clickability alone accepts opacity:0. Check the
  // actual button and every ancestor before treating a PNG as paint evidence.
  await expect(submit).toHaveCSS("opacity", "1");
  await expect.poll(() => submit.evaluate((node) => {
    const hidden = [];
    for (let current: Element | null = node; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.opacity !== "1" || style.visibility !== "visible" || style.display === "none") {
        hidden.push({ tag: current.tagName, opacity: style.opacity, visibility: style.visibility, display: style.display });
      }
    }
    return hidden;
  })).toEqual([]);
  const geometry = await submit.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(node);
    const text = range.getBoundingClientRect();
    return {
      box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
      text: { left: text.left, right: text.right, top: text.top, bottom: text.bottom, width: text.width, height: text.height },
      color: getComputedStyle(node).color,
    };
  });
  expect(geometry.color).not.toMatch(/transparent|rgba\([^)]*,\s*0\s*\)/);
  expect(geometry.text.width, JSON.stringify(geometry)).toBeGreaterThan(0);
  expect(geometry.text.height, JSON.stringify(geometry)).toBeGreaterThan(0);
  expect(geometry.text.left, JSON.stringify(geometry)).toBeGreaterThanOrEqual(geometry.box.left - 1);
  expect(geometry.text.right, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.box.right + 1);
  expect(geometry.text.top, JSON.stringify(geometry)).toBeGreaterThanOrEqual(geometry.box.top - 1);
  expect(geometry.text.bottom, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.box.bottom + 1);
}

for (const [index, locale] of LOCALES.entries()) {
  const messages = messagesFor(locale);
  for (const width of [390, 768, 1110, 1440]) {
    test(`anonymous auth ${locale} ${width}px: login/register copy, labels and layout`, async ({ context, page }, testInfo) => {
      await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: UI }]);
      await page.setViewportSize({ width, height: 718 });
      for (const mode of ["login", "register"]) {
        const url = `${UI}/login${mode === "register" ? "?tab=register" : ""}`;
        await page.goto(url);
        await expectKeyboardSkipLink(page, locale);
        // Keep anonymous screenshots free of the focus/fragment check above.
        await page.goto(url);
        // Removing only a fragment can be a same-document navigation.
        await page.reload();
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(messages.auth[mode].welcome);
        await expect(page.getByLabel(messages.auth.fields.email, { exact: true })).toBeVisible();
        await expect(page.getByLabel(messages.auth.fields.password, { exact: true })).toBeVisible();
        await expect(page.getByRole("combobox")).toHaveValue(locale);
        const ssoSummary = page.locator("main details summary");
        await expect(ssoSummary).toHaveCount(1);
        await expect(ssoSummary).toHaveText(messages.auth.oauth.ssoToggle);
        await expect(ssoSummary).toBeVisible();
        await expect(page.getByText(mode === "login" ? messages.auth.login.newHere : messages.auth.register.hasAccount, { exact: false })).toBeVisible();
        await expect(page.locator("main")).not.toContainText(/3 free runs|Run fully|Remember me|Command the agents you already/);
        await expect(page.locator('input[type="checkbox"]')).toHaveCount(0);
        if (width >= 1024) await expect(page.getByText(messages.auth.hero.title, { exact: true })).toBeVisible();
        await expectPaintedAuthSubmit(page);
        await expect(page.locator(".bv-auth-entry .bv-rise")).toHaveCSS("animation-name", "none");
        const submit = page.locator('form:has(input[type="password"]) button[type="submit"]');
        await expect(submit).toHaveCSS("animation-name", "none");
        expect(await submit.evaluate((node) => getComputedStyle(node, "::before").content)).toBe("none");
        await expectUnclipped(page);
        // Successful anonymous screens are release QA evidence, not synthetic
        // credential/error fixtures. Keep the matrix bounded to 24 PNGs.
        if (width === 390 || width === 1110) {
          const name = `auth-entry-${locale}-${width}-${mode}`;
          const png = await page.screenshot({ fullPage: true, animations: "disabled" });
          expect(png.toString("ascii", 12, 16)).toBe("IHDR");
          expect(png.readUInt32BE(16), `${name}: full-page PNG must fit its viewport`).toBe(width);
          await testInfo.attach(`${name}.png`, {
            body: png,
            contentType: "image/png",
          });
          const sourcePaths = [
            "packages/ui/app/login/page.tsx", "packages/ui/app/login/layout.tsx",
            "packages/ui/app/AuthLayout.tsx",
            "packages/ui/app/layout.tsx", "packages/ui/components/SkipLink.tsx",
            "packages/ui/app/globals.css", "packages/ui/lib/api.ts",
            "packages/ui/lib/auth-errors.ts", `packages/ui/messages/${locale}.json`,
          ];
          await testInfo.attach(`${name}-identity.json`, {
            body: Buffer.from(JSON.stringify({
              sourceRevision: process.env.GITHUB_SHA ?? "local-uncommitted",
              buildId: readFileSync(join(process.cwd(), "packages/ui/.next/BUILD_ID"), "utf8").trim(),
              sources: Object.fromEntries(sourcePaths.map((path) => [path,
                createHash("sha256").update(readFileSync(join(process.cwd(), path))).digest("hex"),
              ])),
              url: page.url(), locale, mode, viewport: page.viewportSize(),
              htmlLang: await page.locator("html").getAttribute("lang"),
              htmlDir: await page.locator("html").getAttribute("dir"),
              browser: page.context().browser()?.version(),
              credentialSubmission: false,
            }, null, 2)),
            contentType: "application/json",
          });
        }
        await page.getByText(messages.auth.oauth.ssoToggle, { exact: true }).click();
        await expectUnclipped(page);
        // Default motion must not make the submit transparent either. Keep
        // screenshots in reduced motion; do not change the evidence matrix.
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await expectPaintedAuthSubmit(page);
        await page.emulateMedia({ reducedMotion: "reduce" });
      }
      await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", messages.auth.login.subtitle);
      await expect(page).toHaveTitle(new RegExp(messages.auth.login.tabSignIn));
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    });
  }

  for (const [status, key] of [[401, "invalidCredentials"], [429, "rateLimited"], [503, "unavailable"]] as const) {
    test(`anonymous login ${locale}: HTTP ${status} is localized`, async ({ context, page }) => {
      await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: UI }]);
      let requests = 0;
      await page.route(/\/api\/v1\/auth\/login$/, async (route) => {
        const headers = {
          "Access-Control-Allow-Origin": UI,
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Requested-With",
        };
        if (route.request().method() === "OPTIONS") {
          await route.fulfill({ status: 204, headers });
          return;
        }
        requests++;
        expect(route.request().method()).toBe("POST");
        await route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify({ message: "Raw English backend detail" }) });
      });
      await page.goto(`${UI}/login`);
      await page.getByLabel(messages.auth.fields.email, { exact: true }).fill("synthetic-auth@example.test");
      await page.getByLabel(messages.auth.fields.password, { exact: true }).fill("Synthetic-Only-123!");
      await page.locator("form").filter({ has: page.locator('input[type="password"]') }).getByRole("button", { name: messages.auth.submit.signIn, exact: true }).click();
      await expect(page.getByRole("main").getByRole("alert")).toHaveText(messages.auth.errors[key]);
      expect(requests).toBe(1);
      await expect(page).toHaveURL(`${UI}/login`);
    });
  }

  test(`anonymous auth ${locale}: reset labels and language selection work`, async ({ context, page }) => {
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: UI }]);
    await page.goto(`${UI}/login`);
    await page.getByRole("button", { name: messages.auth.forgot.link, exact: true }).click();
    const reset = page.locator(".bv-glass").filter({ has: page.getByRole("heading", { name: messages.auth.forgot.modalTitle, exact: true }) });
    await expect(reset.getByRole("textbox", { name: messages.auth.fields.email, exact: true })).toBeVisible();
    await reset.getByRole("button", { name: messages.auth.forgot.backToLogin, exact: true }).click();
    await expect(reset).toHaveCount(0);
    const nextLocale = locale === "tr" ? "ar" : LOCALES[(index + 1) % LOCALES.length];
    // The existing selector reloads the document; do not mask a stale label
    // with a second test-driven reload or a same-URL wait that resolves early.
    await Promise.all([
      page.waitForEvent("domcontentloaded"),
      page.getByRole("combobox").selectOption(nextLocale),
    ]);
    await expect(page.locator("html")).toHaveAttribute("lang", nextLocale);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(messagesFor(nextLocale).auth.login.welcome);
    await expectKeyboardSkipLink(page, nextLocale);
    expect((await context.cookies()).find((cookie) => cookie.name === "NEXT_LOCALE")?.value).toBe(nextLocale);
  });
}

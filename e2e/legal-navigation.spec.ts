import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test, expect, type Page, type Locator } from "@playwright/test";

const UI = "http://operator.example:4311";
const DELETION = "/legal/account-deletion";
const LOCALES = ["en", "tr", "es", "de", "fr", "ar"] as const;
const PATHS = ["/terms", "/gdpr", DELETION];
const HREFS = ["/privacy", "/terms", "/cookies", "/gdpr", "/kvkk", DELETION];
const WIDTHS = [390, 768, 1110];
const MOTIONS = ["reduce", "no-preference"] as const;
type Copy = Record<"legal" | "openApp" | "privacy" | "terms" | "cookies" | "accountDeletion" | "onThisPage" | "permalinkTo", string>;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const read = (path: string) => readFileSync(join(process.cwd(), path));
const messagesFor = (locale: string) => JSON.parse(read(`packages/ui/messages/${locale}.json`).toString("utf8"));
const git = (...args: string[]) => execFileSync("git", args, {encoding: "utf8", timeout: 5000, maxBuffer: 65536}).trim();
const buildId = () => read("packages/ui/.next/BUILD_ID").toString("utf8").trim();
function sourcePaths(locale: string) {
 return [
  "e2e/legal-navigation.spec.ts", "e2e/auth-entry.spec.ts", "e2e/surface-domain.spec.ts", "playwright.config.ts",
  ...PATHS.flatMap((path) => [`packages/ui/app${path}/page.tsx`, `packages/ui/app${path}/layout.tsx`]),
  "packages/ui/app/layout.tsx", "packages/ui/app/globals.css", "packages/ui/components/SkipLink.tsx",
  "packages/ui/middleware.ts", "packages/ui/lib/surface-domain.ts", `packages/ui/messages/${locale}.json`,
 ];
}
const sourceHashes = (locale: string) => Object.fromEntries(sourcePaths(locale).map((path) => [path, sha(read(path))]));
function identity(locale: string) {
 const manifestPath = process.env.E2E_SOURCE_MANIFEST;
 if (manifestPath) {
  // Isolated candidates may contain intentional WIP and have no .git folder.
  // Assert exact candidate bytes instead of pretending they are a clean commit.
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const sources = sourceHashes(locale);
  for (const [path, digest] of Object.entries(sources)) {
   expect(manifest.sources[path], `candidate source drift: ${path}`).toBe(digest);
  }
  const id = buildId(); expect(id.length).toBeGreaterThan(0);
  return { sourceMode: "isolated-candidate", sourceRevision: null, sourceTree: null,
   baselineRevision: manifest.baselineRevision, candidateSourceSha256: manifest.candidateSourceSha256,
   sourceManifestSha256: sha(readFileSync(manifestPath)),
   triggerRevision: process.env.GITHUB_SHA ?? null, buildId: id, sources };
 }
 const sourceRevision = git("rev-parse", "HEAD");
 const sourceTree = git("rev-parse", "HEAD^{tree}");
 expect(sourceRevision).toMatch(/^[a-f0-9]{40}$/);
 expect(sourceTree).toMatch(/^[a-f0-9]{40}$/);
 git("ls-files", "--error-unmatch", "--", ...sourcePaths(locale));
 git("diff", "--quiet", sourceRevision, "--", ...sourcePaths(locale));
 const id = buildId();
 expect(id.length).toBeGreaterThan(0);
 return {sourceRevision, sourceTree, triggerRevision: process.env.GITHUB_SHA ?? null,
  buildId: id, sources: sourceHashes(locale)};
}
async function localeProof(page: Page, locale: string) {
 await expect(page.locator("html")).toHaveAttribute("lang", locale);
 await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
 expect((await page.context().cookies(UI)).find((cookie) => cookie.name === "NEXT_LOCALE")?.value).toBe(locale);
}
async function chrome(page: Page, locale: string, path: string, width: number) {
 const messages = messagesFor(locale);
 const copy: Copy = messages.static.common.legalNavigation;
 await localeProof(page, locale);
 const header = page.locator("header");
 await expect(header).toHaveCount(1);
 const eyebrow = header.locator("span.material-symbols-outlined").filter({hasText: /^gavel$/}).locator("..");
 await expect(eyebrow).toHaveCount(1);
 await expect(eyebrow).toBeVisible();
 await expect.poll(() => eyebrow.evaluate((node) => Array.from(node.childNodes)
  .filter((child) => child.nodeType === Node.TEXT_NODE).map((child) => child.textContent).join("").trim())).toBe(copy.legal);
 const labels = [copy.privacy, copy.terms, copy.cookies, "GDPR", "KVKK", copy.accountDeletion];
 const pills = header.locator(".bv-fpill");
 await expect(pills).toHaveCount(6);
 for (const [index, label] of labels.entries()) {
  const pill = pills.nth(index);
  await expect(pill).toHaveText(label);
  await expect(pill).toHaveAccessibleName(label);
  await expect(pill).toBeVisible();
  expect(await pill.evaluate((node) => node.tagName)).toBe(path === "/terms" ? "BUTTON" : "A");
  if (path !== "/terms") await expect(pill).toHaveAttribute("href", HREFS[index]);
 }
 await expect(header.locator(".bv-fpill.active")).toHaveText(path === "/terms" ? copy.terms : path === "/gdpr" ? "GDPR" : copy.accountDeletion);
 if (path === "/terms") await expect(header.locator("a")).toHaveCount(0);
 const openApp = page.locator('a[href="https://app.braavolabs.com"]');
 await expect(openApp).toHaveCount(1);
 await expect(openApp).toHaveText(copy.openApp);
 await expect(openApp).toHaveAccessibleName(copy.openApp);
 const top = page.locator("nav").filter({has: openApp});
 await expect(top).toHaveCount(1);
 if (path === "/gdpr") {
  const backLabel = locale === "ar" ? "→ رجوع" : messages.static.common.back;
  const back = top.locator('a.bv-btn-ghost[href="/"]');
  await expect(back).toHaveCount(1);
  await expect(back).toHaveAttribute("href", "/");
  await expect(back).toHaveText(backLabel);
  await expect(back).toHaveAccessibleName(backLabel);
  expect(((await back.textContent()) ?? "").match(/[←→]/g)).toEqual([locale === "ar" ? "→" : "←"]);
  await expect(top.locator(".material-symbols-outlined").filter({hasText: /^arrow_back$/})).toHaveCount(0);
 } else {
  const links = [["/features", messages.nav.features], ["/pricing", messages.nav.pricing], ["/about", messages.static.common.legalPage.about]];
  if (path === "/terms") links.push(["/changelog", messages.static.changelog.title]);
  for (const [href, label] of links) {
   const link = top.locator(`a[href="${href}"]`);
   await expect(link).toHaveCount(1);
   await expect(link).toHaveText(label);
   if (width >= 768) {
    await expect(link).toBeVisible();
    await expect(link).toHaveAccessibleName(label);
   }
   else await expect(link).toBeHidden();
  }
  const signIn = top.locator('a[href="https://app.braavolabs.com/login"]');
  await expect(signIn).toHaveCount(1);
  await expect(signIn).toBeVisible();
  await expect(signIn).toHaveText(messages.nav.signIn);
  await expect(signIn).toHaveAccessibleName(messages.nav.signIn);
 }
 const title = path === "/terms" ? messages.static.legal.terms.title : path === "/gdpr" ? "GDPR Statement" : "Account & Data Deletion";
 await expect(header.locator("h1")).toHaveText(title);
 const date = header.locator("p.bv-mono");
 await expect(date).toHaveText(messages.static.common.lastUpdated + " " + (path === "/terms" ? messages.static.legal.terms.date
  : new Intl.DateTimeFormat(locale, {month: "long", year: "numeric", timeZone: "UTC"}).format(new Date("2026-05-01T00:00:00Z"))));
 const toc = page.locator("nav[aria-label]");
 await expect(toc).toHaveCount(1);
 await expect(toc).toHaveAttribute("aria-label", copy.onThisPage);
 await expect(toc.locator("p.bv-micro")).toHaveText(copy.onThisPage);
 if (width === 1110 || (width === 768 && path !== "/gdpr")) await expect(toc).toBeVisible();
 else await expect(toc).toBeHidden();
 const section = path === "/terms" ? messages.static.legal.terms.sections[0].title : path === "/gdpr" ? "Data Controller" : "Overview";
 const permalink = page.locator("article h2 a").first();
 await expect(permalink).toBeAttached();
 await expect(permalink).toHaveAccessibleName(copy.permalinkTo.replace("{title}", section));
 expect(await permalink.getAttribute("href")).toBe(await toc.locator("a").first().getAttribute("href"));
 await expect(toc.locator("a").first()).toHaveText(section);
 if (path !== "/terms") {
  for (const owner of [header.locator("h1"), page.locator("article"), toc.locator('div[lang="en"]')]) {
   await expect(owner).toHaveCount(1);
   await expect(owner).toHaveAttribute("lang", "en");
   await expect(owner).toHaveAttribute("dir", "ltr");
   await expect(owner).toHaveCSS("direction", "ltr");
  }
  await expect(toc).not.toHaveAttribute("lang", "en");
  await expect(permalink).toHaveAttribute("lang", locale);
  await expect(permalink).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
  await expect(date.locator("time")).toHaveAttribute("datetime", "2026-05");
  expect(await header.locator("h1").evaluate((node) => node.textContent?.trim().toLocaleUpperCase(node.getAttribute("lang") ?? "en"))).toBe(title.toUpperCase());
 }
 if (path === "/gdpr") {
  const banner = header.locator(".bv-panel");
  await expect(banner).toHaveCount(locale === "en" ? 0 : 1);
  if (locale !== "en") {
   await expect(banner).toContainText(messages.static.singleLocale.gdprBanner);
   await expect(banner).toHaveCSS("display", "flex");
   const noticeBox = await banner.boundingBox();
   const badgeBox = await eyebrow.boundingBox();
   const headerBox = await header.boundingBox();
   expect(noticeBox).not.toBeNull();
   expect(badgeBox).not.toBeNull();
   expect(headerBox).not.toBeNull();
   if (!noticeBox || !badgeBox || !headerBox) throw new Error("Missing GDPR header geometry");
   expect(badgeBox.y).toBeGreaterThanOrEqual(noticeBox.y + noticeBox.height);
   const center = headerBox.x + headerBox.width / 2;
   expect(Math.abs(noticeBox.x + noticeBox.width / 2 - center)).toBeLessThanOrEqual(1);
   expect(Math.abs(badgeBox.x + badgeBox.width / 2 - center)).toBeLessThanOrEqual(1);
  }
 }
 if (path === DELETION) {
  const banner = header.locator(".bv-panel");
  await expect(banner).toHaveCount(locale === "en" ? 0 : 1);
  if (locale !== "en") await expect(banner).toHaveText(messages.static.common.legalPage.englishOnly);
 }
 await expect(page.locator("body")).not.toContainText(/static\.common\.legalNavigation\.|\{title\}/);
}
async function geometry(page: Page, controls: Locator, expectedCount = 7) {
 await expect(controls).toHaveCount(expectedCount);
 for (const control of await controls.all()) await expect(control).toBeVisible();
 await expect.poll(() => controls.evaluateAll((nodes) => nodes.flatMap((node) => {
  const hidden: string[] = [];
  for (let p: Element | null = node; p; p = p.parentElement) {
   const s = getComputedStyle(p);
   if (s.opacity !== "1" || s.visibility !== "visible" || s.display === "none") hidden.push(p.tagName + ":" + s.opacity + ":" + s.visibility);
  }
  return hidden;
 }))).toEqual([]);
 const g = await controls.evaluateAll((nodes) => ({
  width: innerWidth, height: innerHeight,
  document: {client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth},
  body: {client: document.body.clientWidth, scroll: document.body.scrollWidth},
  controls: nodes.map((node) => {
   const b = node.getBoundingClientRect();
   const range = document.createRange();
   range.selectNodeContents(node);
   const t = range.getBoundingClientRect();
   const clipped: string[] = [];
   for (let p = node.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p), r = p.getBoundingClientRect();
    if (s.overflowX !== "visible" && (t.left < r.left - 1 || t.right > r.right + 1)) clipped.push(p.tagName + ":x");
    if (s.overflowY !== "visible" && (t.top < r.top - 1 || t.bottom > r.bottom + 1)) clipped.push(p.tagName + ":y");
   }
   const hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
   const before = getComputedStyle(node, "::before");
   return {label: node.textContent?.trim(), left: b.left, right: b.right, top: b.top, bottom: b.bottom,
    width: b.width, height: b.height, client: node.clientWidth, scroll: node.scrollWidth,
    text: {left: t.left, right: t.right, top: t.top, bottom: t.bottom, width: t.width, height: t.height},
    color: getComputedStyle(node).color, clipped, hit: hit !== null && (hit === node || node.contains(hit)),
    before: {content: before.content, transform: before.transform, animation: before.animationName}};
  }),
 }));
 for (const box of [g.document, g.body]) {
  expect(box.scroll, JSON.stringify(g)).toBeLessThanOrEqual(g.width + 1);
  expect(box.scroll, JSON.stringify(g)).toBeLessThanOrEqual(box.client + 1);
 }
 for (const box of g.controls) {
  const evidence = JSON.stringify(box);
  for (const value of [box.width, box.height, box.text.width, box.text.height]) expect(value, evidence).toBeGreaterThan(0);
  for (const value of [box.left, box.top]) expect(value, evidence).toBeGreaterThanOrEqual(-1);
  for (const [value, max] of [[box.right, g.width], [box.bottom, g.height]]) expect(value, evidence).toBeLessThanOrEqual(max + 1);
  expect(box.scroll, evidence).toBeLessThanOrEqual(box.client + 1);
  for (const [value, min] of [[box.text.left, box.left], [box.text.top, box.top]]) expect(value, evidence).toBeGreaterThanOrEqual(min - 1);
  for (const [value, max] of [[box.text.right, box.right], [box.text.bottom, box.bottom]]) expect(value, evidence).toBeLessThanOrEqual(max + 1);
  expect(box.color, evidence).not.toMatch(/transparent|rgba\([^)]*,\s*0(?:\.0+)?\s*\)|\/\s*0(?:\.0+)?\s*\)$/);
  expect(box.clipped, evidence).toEqual([]);
  expect(box.hit, evidence).toBe(true);
 }
 for (let i = 0; i < g.controls.length; i++) for (let j = i + 1; j < g.controls.length; j++) {
  const a = g.controls[i], b = g.controls[j];
  const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  expect(x > 1 && y > 1, JSON.stringify({a, b, x, y})).toBe(false);
 }
 return g;
}
async function anchorProof(page: Page, path: string, width: number, documents: string[]) {
 const start = page.url(), before = documents.length, toc = page.locator("nav[aria-label]");
 const links = toc.locator("a"), middle = Math.floor(await links.count() / 2);
 const visible = await toc.isVisible(), evidence: unknown[] = [];
 for (const [index, via] of (visible ? [[middle, "toc"], [middle + 1, "permalink"]] : [[middle, "permalink"]]) as [number, string][]) {
  const href = await links.nth(index).getAttribute("href");
  expect(href).toMatch(/^#[a-z0-9]+(?:-[a-z0-9]+)*$/);
  const target = page.locator(`[id="${href!.slice(1)}"]`);
  await expect(target).toHaveCount(1);
  const heading = path === DELETION ? target.locator("h2") : target;
  if (via === "toc") await links.nth(index).click();
  else { await heading.hover(); await heading.locator("a").click(); }
  await expect(page).toHaveURL(start + href);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  const measure = () => target.evaluate((node, showToc) => {
   const top = document.querySelector('nav:not([aria-label])')!;
   const toc = document.querySelector("nav[aria-label]")!;
   const rect = (el: Element) => {
    const b = el.getBoundingClientRect(), hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
    return {top: b.top, bottom: b.bottom, hit: hit !== null && (hit === el || el.contains(hit))};
   };
   return {scrollY, offset: parseFloat(getComputedStyle(node).scrollMarginTop), top: rect(top), target: rect(node),
    heading: rect(node.matches("h2") ? node : node.querySelector("h2")!),
    toc: showToc ? {position: getComputedStyle(toc).position, ...rect(toc.querySelector("p")!)} : null,
    controls: Array.from(top.querySelectorAll("a")).filter((a) => a.getClientRects().length > 0).map(rect)};
  }, visible);
  await expect.poll(async () => {
   const previous = await measure();
   await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
   const s = await measure();
   return Math.abs(s.scrollY - previous.scrollY) <= 1 && s.target.top >= s.top.bottom - 2 && s.heading.top >= s.top.bottom - 2 && s.heading.hit
    && (!s.toc || s.toc.top >= s.top.bottom - 2 && s.toc.hit) && s.controls.every((c) => c.hit);
  }).toBe(true);
  const s = await measure();
  expect(s.offset).toBe(width < 1024 ? 140 : 90);
  expect(s.top.top).toBeGreaterThanOrEqual(-1);
  expect(s.top.bottom).toBeLessThanOrEqual(s.offset);
  if (s.toc) expect(s.toc.position).toBe("sticky");
  evidence.push({via, href, ...s});
 }
 // Restore via real history navigation, without changing scroll or fragment in JavaScript.
 for (let i = 0; i < evidence.length; i++) await page.goBack();
 await expect(page).toHaveURL(start);
 expect(documents.length).toBe(before);
 return evidence;
}
async function termsJump(page: Page, locale: string, documents: string[]) {
 const copy: Copy = messagesFor(locale).static.common.legalNavigation;
 const before = documents.length;
 await page.evaluate(() => window.scrollTo(0, 120));
 await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
 const button = page.locator("header").getByRole("button", {name: copy.accountDeletion, exact: true});
 await button.click();
 await expect(page.locator("header h1")).toHaveText(copy.accountDeletion);
 await expect(page.locator("header .bv-fpill.active")).toHaveText(copy.accountDeletion);
 await expect(page.locator("header button.bv-fpill")).toHaveCount(6);
 await expect(page.locator("article h2")).toHaveCount(0);
 await expect(page).toHaveURL(UI + "/terms");
 expect(documents.length).toBe(before);
 await expect.poll(() => page.evaluate(() => scrollY)).toBeLessThanOrEqual(1);
 const link = page.locator("article a");
 await expect(link).toHaveCount(1);
 await expect(link).toHaveAttribute("href", DELETION);
 await expect(link).toHaveText("braavolabs.com/legal/account-deletion");
 await link.hover();
 const [request, response] = await Promise.all([
  page.waitForRequest((r) => r.isNavigationRequest() && r.resourceType() === "document" && r.url() === UI + DELETION),
  page.waitForResponse((r) => r.request().isNavigationRequest() && r.request().resourceType() === "document" && r.url() === UI + DELETION),
  page.waitForEvent("domcontentloaded"),
  link.click(),
 ]);
 expect(request.headers().rsc).toBeUndefined();
 expect(request.headers()["next-router-prefetch"]).toBeUndefined();
 expect(new URL(request.url()).searchParams.has("_rsc")).toBe(false);
 expect(response.status()).toBe(200);
 expect(response.headers()["content-type"]).toContain("text/html");
 await expect(page).toHaveURL(UI + DELETION);
 await expect(page.locator("header h1")).toHaveText("Account & Data Deletion");
 await localeProof(page, locale);
 expect(await page.evaluate(() => localStorage.getItem("cookie_consent"))).toBe("essential-only");
 return {url: page.url(), method: request.method(), status: response.status(),
  resourceType: request.resourceType(), navigation: request.isNavigationRequest(), rsc: request.headers().rsc ?? null};
}

test.use({deviceScaleFactor: 1, serviceWorkers: "block"});
for (const locale of LOCALES) for (const path of PATHS) {
 test(`legal navigation ${locale} ${path}: three widths, two motions, real document semantics`, async ({context, page}, testInfo) => {
  const source = identity(locale);
  const blocked: string[] = [], rsc: string[] = [], rscErrors: string[] = [], documents: string[] = [];
  await context.route("**/*", (route) => {
   const request = route.request(), url = new URL(request.url());
   if (!(["GET", "HEAD"].includes(request.method())) || url.pathname.startsWith("/api/")
    || /(^|\.)braavolabs\.com$/.test(url.hostname)) {
    blocked.push(request.method() + " " + url.origin + url.pathname);
    return route.abort();
   }
   return route.continue();
  });
  await context.addInitScript(() => localStorage.setItem("cookie_consent", "essential-only"));
  await context.addCookies([{name: "NEXT_LOCALE", value: locale, url: UI}]);
  await page.setExtraHTTPHeaders({"X-Forwarded-Proto": "https"});
  page.on("request", (request) => {
   if (request.isNavigationRequest() && request.resourceType() === "document") documents.push(request.url());
   const url = new URL(request.url()), h = request.headers();
   if ([...HREFS, "/deletion"].includes(url.pathname)
    && (h.rsc !== undefined || h["next-router-prefetch"] !== undefined || url.searchParams.has("_rsc")
     || /prefetch/i.test(h.purpose ?? h["sec-purpose"] ?? ""))) rsc.push(request.url());
  });
  page.on("console", (message) => { if (/Failed to fetch RSC payload/.test(message.text())) rscErrors.push(message.text().slice(0, 200)); });
  const shots: Array<{name: string; png: Buffer; evidence: Record<string, unknown>}> = [];
  for (const width of WIDTHS) {
   const matrix: Record<string, unknown> = {};
   for (const motion of MOTIONS) {
    await page.setViewportSize({width, height: 718});
    await page.emulateMedia({reducedMotion: motion});
    const response = await page.goto(UI + path, {waitUntil: "load"});
    expect(response?.status()).toBe(200);
    await page.evaluate(async () => { await document.fonts.ready; window.scrollTo(0, 0); });
    await expect(page).toHaveURL(UI + path);
    await chrome(page, locale, path, width);
    const controls = page.locator('header .bv-fpill, a[href="https://app.braavolabs.com"]');
    const topControls = page.locator('nav:not([aria-label]) a:visible');
    const topCount = path === "/gdpr" || width === 390 ? 3 : path === "/terms" ? 7 : 6;
    const cell: {geometry: unknown; topGeometry: unknown; anchors?: unknown; navigation?: unknown} = {
     geometry: await geometry(page, controls), topGeometry: await geometry(page, topControls, topCount),
    };
    matrix[motion] = cell;
    if (motion === "reduce") {
     const name = `legal-nav-${locale}-${path.slice(1).replaceAll("/", "-")}-${width}-reduce`;
     const png = await page.screenshot({fullPage: false});
     expect(png.toString("ascii", 12, 16)).toBe("IHDR");
     expect(png.readUInt32BE(16)).toBe(width);
     expect(png.readUInt32BE(20)).toBe(718);
     shots.push({name, png, evidence: {...source, url: page.url(), locale, path,
      viewport: page.viewportSize(), motion, matrix, capturedAt: new Date().toISOString(),
      htmlLang: await page.locator("html").getAttribute("lang"), htmlDir: await page.locator("html").getAttribute("dir"),
      browser: context.browser()?.version(), retry: testInfo.retry, pngSha256: sha(png),
      credentialSubmission: false, consentFixture: "essential-only"}});
    }
    cell.anchors = await anchorProof(page, path, width, documents);
    if (path === "/terms") cell.navigation = await termsJump(page, locale, documents);
   }
  }
  expect(blocked).toEqual([]);
  expect(rsc).toEqual([]);
  expect(rscErrors).toEqual([]);
  expect(sourceHashes(locale)).toEqual(source.sources);
  if (source.sourceRevision !== null) expect(git("rev-parse", "HEAD")).toBe(source.sourceRevision);
  else expect(sha(readFileSync(process.env.E2E_SOURCE_MANIFEST!))).toBe(source.sourceManifestSha256);
  expect(buildId()).toBe(source.buildId);
  expect(shots).toHaveLength(3);
  for (const shot of shots) {
   await testInfo.attach(shot.name + ".png", {body: shot.png, contentType: "image/png"});
   await testInfo.attach(shot.name + "-identity.json", {
    body: Buffer.from(JSON.stringify(shot.evidence, null, 2)), contentType: "application/json",
   });
  }
 });
}

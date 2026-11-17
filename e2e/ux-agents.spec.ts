import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { UI } from "./ports";

/**
 * BRA-UX-05g — Ajanlar: `/agents` (bayrak `NEXT_PUBLIC_UX_AGENTS`, varsayılan KAPALI). `UI` bayrak KAPALI → rota 404 (öncesinde de yoktu),
 * `UI_LAB` AÇIK. API tarayıcıda `page.route` ile taklit edilir. `UX_AGENTS_SCREEN_DIR` verilirse ekran görüntüleri kaydedilir.
 */
/** AÇIK sunucu kök adresi. playwright.config.ts'e DOKUNULMAZ (kök sözleşme testi satırları birebir bekler): CI'da tanımsız, AÇIK testleri atlanır;
 * yerelde bayrağı AÇIK ikinci bir `next start` ile koşturup `E2E_UX_AGENTS_BASE=http://operator.example:<port>` verilir. */
const OPEN = process.env.E2E_UX_AGENTS_BASE;
const SHOTS = process.env.UX_AGENTS_SCREEN_DIR;
const isApi = (url: URL) => url.pathname.startsWith("/api/v1/") && (url.hostname === "api.operator.example" || url.host === "localhost:8080");
const DRAFT = { name: "Satış Özetçisi", role: "sales_summarizer", systemPrompt: "Her sabah satış e-postalarını okur ve kısa bir özet çıkarır.", tools: ["gmail"] };
type Calls = { method: string; path: string; body?: string | null }[];

async function mockApi(page: Page, opts: { draftStatus?: number } = {}): Promise<Calls> {
  const calls: Calls = [];
  await page.route(isApi, async (route: Route) => {
    const req = route.request();
    const origin = req.headers().origin ?? UI;
    const cors = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const path = new URL(req.url()).pathname.replace(/^\/api\/v1/, "");
    calls.push({ method: req.method(), path, body: req.postData() });
    const json = (status: number, data: unknown) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(data) });
    if (path === "/companies") return json(200, [{ id: "c1", name: "Atölye" }]);
    if (path === "/companies/c1/agents" && req.method() === "GET") return json(200, [{ id: "a1", name: "Destek ajanı", role: "support", tools: ["gmail", "slack_post"], autonomy: "BALANCED" }]);
    if (path === "/companies/c1/agents/compose/draft") return opts.draftStatus ? json(opts.draftStatus, { error: "no" }) : json(200, { draft: DRAFT, droppedTools: ["notion_write"], provider: "anthropic", model: "claude-x", tokens: { input: 1, output: 1 } });
    if (path === "/companies/c1/agents/compose/confirm") return json(201, { agent: { id: "a2", ...DRAFT }, droppedTools: ["notion_write"] });
    return json(200, req.method() === "GET" ? [] : {});
  });
  return calls;
}

async function prepare(page: Page, scheme: "light" | "dark") {
  await page.setExtraHTTPHeaders({ "X-Forwarded-Proto": "https" });
  await page.addInitScript((s) => {
    try {
      localStorage.setItem("braavo-theme", s);
      localStorage.setItem("cookie_consent", "essential-only");
      localStorage.setItem("aicos-auth", JSON.stringify({ state: { token: "e2e-token", refreshToken: null, tenantId: "t1", theme: s }, version: 0 }));
    } catch { /* storage kapalı */ }
  }, scheme);
}

test.use({ locale: "tr-TR", timezoneId: "UTC" });

test("bayrak KAPALI: /agents 404 (bu biletten önceki davranış)", async ({ page }) => {
  test.skip(!!process.env.NEXT_PUBLIC_UX_AGENTS, "kabuk ortamında NEXT_PUBLIC_UX_AGENTS tanımlı: KAPALI sunucu bayrağı miras alır (CI'da tanımsız)");
  await prepare(page, "dark");
  await mockApi(page);
  const res = await page.goto(`${UI}/agents`);
  expect(res?.status()).toBe(404);
  expect(await page.getByTestId("agents-page").count()).toBe(0);
});

const COMBOS = [
  { vp: "masaustu-1440", size: { width: 1440, height: 900 }, scheme: "dark" as const },
  ...(SHOTS ? [
    { vp: "masaustu-1440", size: { width: 1440, height: 900 }, scheme: "light" as const },
    { vp: "mobil-390", size: { width: 390, height: 844 }, scheme: "dark" as const },
    { vp: "mobil-390", size: { width: 390, height: 844 }, scheme: "light" as const },
  ] : []),
];

for (const { vp, size, scheme } of COMBOS) {
  test.describe(`bayrak AÇIK: ajanlar (${vp}, ${scheme})`, () => {
    test.use({ viewport: size });
    test.skip(!OPEN, "E2E_UX_AGENTS_BASE tanımsız: bayrak AÇIK sunucu yok (bkz. dosya başı)");

    test("liste, taslak (kayıt yok), droppedTools, onay, taşma yok", async ({ page }) => {
      if (SHOTS) mkdirSync(SHOTS, { recursive: true });
      const shot = async (name: string) => { if (SHOTS) { await page.waitForTimeout(400); await page.screenshot({ path: join(SHOTS, `${name}-${vp}-${scheme}.png`), fullPage: true }); } };
      await prepare(page, scheme);
      const calls = await mockApi(page);
      await page.goto(`${OPEN}/agents`);
      await expect(page.getByRole("heading", { level: 1, name: "Ajanlar" })).toBeVisible();
      const row = page.getByTestId("agent-row");
      await expect(row).toContainText("Destek ajanı");
      await expect(row).toContainText("Atölye");
      await expect(row).toContainText("Durum: Bilinmiyor");
      await shot("01-liste");

      await page.getByTestId("agents-new").click();
      await page.getByTestId("agents-description").fill("Her sabah satış e-postalarını özetle");
      await page.getByTestId("agents-draft").click();
      await expect(page.getByTestId("agents-draft-preview")).toContainText("Satış Özetçisi");
      await expect(page.getByTestId("agents-dropped")).toContainText("notion_write");
      expect(calls.filter((c) => c.path.endsWith("/compose/confirm"))).toEqual([]); // taslak kayıt yazmaz
      await shot("02-taslak");

      await page.getByTestId("agents-confirm").click();
      await expect(page.getByTestId("agents-created")).toContainText("Satış Özetçisi");
      const confirm = calls.filter((c) => c.path.endsWith("/compose/confirm"));
      expect(confirm).toHaveLength(1);
      expect(JSON.parse(confirm[0].body ?? "{}")).toEqual({ draft: DRAFT });
      await shot("03-olusturuldu");
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    });

    test("402 açık metin", async ({ page }) => {
      await prepare(page, scheme);
      await mockApi(page, { draftStatus: 402 });
      await page.goto(`${OPEN}/agents`);
      await page.getByTestId("agents-new").click();
      await page.getByTestId("agents-description").fill("Her sabah satış e-postalarını özetle");
      await page.getByTestId("agents-draft").click();
      await expect(page.getByTestId("agents-error")).toContainText("402");
      if (SHOTS) { await page.waitForTimeout(400); await page.screenshot({ path: join(SHOTS, `04-hata402-${vp}-${scheme}.png`), fullPage: true }); }
    });
  });
}

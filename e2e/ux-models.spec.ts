import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { UI, UI_LAB } from "./ports";

/**
 * BRA-UX-05h — Modeller ve bağlantılar: `/settings/models` (bayrak `NEXT_PUBLIC_UX_MODELS`, varsayılan KAPALI).
 *
 * İki sunucu AYNI derlemeyi sunar (playwright.config.ts): `UI` bayrak KAPALI → rota 404 (yeni rota; eski sayfa yok, `/settings` değişmez),
 * `UI_LAB` bayrak AÇIK (istek anında okunur). API tarayıcıda `page.route` ile taklit edilir (Postgres/API gerekmez).
 * `UX_MODELS_SCREEN_DIR` verilirse ekran görüntüleri (1440×900 + 390×844 × açık/koyu) kaydedilir.
 */
const SHOTS = process.env.UX_MODELS_SCREEN_DIR;
/** `NEXT_PUBLIC_API_URL` derleme anında gömülür (yerelde localhost:8080, CI'da operator adresi): ikisi de yakalanır. */
const isApi = (url: URL) => url.pathname.startsWith("/api/v1/") && (url.hostname === "api.operator.example" || url.host === "localhost:8080");

const COMPANIES = [{ id: "c1", name: "Atölye" }, { id: "c2", name: "Ofis" }, { id: "c3", name: "Çok uzun bir şirket adı: Kuzey Yakası Dış Ticaret ve Lojistik Hizmetleri Anonim Şirketi İstanbul Şubesi" }];
const WINDOW = { from: "2026-11-01T00:00:00.000Z", to: "2026-11-13T10:00:00.000Z" };
const overview = (models: unknown[], auto: boolean | null = null) => ({ autoSelection: { enabled: auto }, models, generatedAt: "2026-11-13T10:00:00.000Z", costWindow: WINDOW });
const M_BYOK = { id: "claude-sonnet-5", provider: "anthropic", source: "byok", access: { scope: "company", mode: null }, costThisMonthUsd: "1.234500", runCountThisMonth: 7 };
const M_UNKNOWN = { id: "yerel-llama", provider: null, source: null, access: { scope: null, mode: null }, costThisMonthUsd: null, runCountThisMonth: null };
const M_ZERO = { id: "gpt-zero", provider: "openai", source: "platform", access: { scope: "workspace", mode: "read_write" }, costThisMonthUsd: "0.000000", runCountThisMonth: 0 };
const M_TINY = { id: "mini-model", provider: "mistral", source: "local", access: { scope: "agent", mode: "read" }, costThisMonthUsd: "0.000012", runCountThisMonth: 1 };
const BY_COMPANY: Record<string, unknown> = { c4: overview([M_BYOK, M_TINY, M_ZERO], true), c1: overview([M_BYOK, M_UNKNOWN, M_ZERO]), c2: overview([], true), c3: overview([M_UNKNOWN, M_TINY]) };

type Calls = { method: string; path: string }[];
interface MockOpts { companies?: unknown[]; modelsStatus?: Record<string, number>; modelsDelayMs?: Record<string, number> }

async function mockApi(page: Page, opts: MockOpts = {}): Promise<Calls> {
  const calls: Calls = [];
  await page.route(isApi, async (route: Route) => {
    const req = route.request();
    const origin = req.headers().origin ?? UI;
    const cors = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api\/v1/, "");
    calls.push({ method: req.method(), path });
    const json = (status: number, data: unknown) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(data) });
    if (path === "/companies") return json(200, opts.companies ?? COMPANIES);
    const m = path.match(/^\/companies\/([^/]+)\/models$/);
    if (m) {
      const delay = opts.modelsDelayMs?.[m[1]];
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const st = opts.modelsStatus?.[m[1]];
      if (st && st >= 400) return json(st, { error: "no" });
      return json(200, BY_COMPANY[m[1]] ?? overview([]));
    }
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

test.describe("bayrak KAPALI: /settings/models yok (404), mevcut /settings değişmez", () => {
  test("rota 404 verir ve yeni bileşen yok", async ({ page }) => {
    await prepare(page, "dark");
    await mockApi(page);
    const res = await page.goto(`${UI}/settings/models`);
    expect(res?.status()).toBe(404);
    expect(await page.getByTestId("models-page").count()).toBe(0);
  });

  test("/settings bayrak kapalıyken de açılır (yeni rota ona dokunmaz)", async ({ page }) => {
    await prepare(page, "dark");
    await mockApi(page);
    const res = await page.goto(`${UI}/settings`);
    expect(res?.status()).toBeLessThan(400);
    expect(await page.getByTestId("models-page").count()).toBe(0);
  });

  test("oturumsuz erişimde açık sunucu login'e yönlenir (içerik sızmaz)", async ({ page }) => {
    await page.setExtraHTTPHeaders({ "X-Forwarded-Proto": "https" });
    const res = await page.goto(`${UI_LAB}/settings/models`);
    await page.waitForURL(/\/login/);
    expect(res?.status()).toBeLessThan(500);
  });
});

const COMBOS = [
  { vp: "masaustu-1440", size: { width: 1440, height: 900 }, scheme: "dark" as const },
  ...(SHOTS ? [
    { vp: "masaustu-1440", size: { width: 1440, height: 900 }, scheme: "light" as const },
    { vp: "mobil-390", size: { width: 390, height: 844 }, scheme: "dark" as const },
    { vp: "mobil-390", size: { width: 390, height: 844 }, scheme: "light" as const },
  ] : []),
];
const snap = async (page: Page, file: string) => { await page.waitForTimeout(450); await page.screenshot({ path: file }); };

for (const { vp, size, scheme } of COMBOS) {
  test.describe(`bayrak AÇIK: modeller (${vp}, ${scheme})`, () => {
    test.use({ viewport: size });

    test("liste, Bilinmiyor alanları, şirket değişimi, boş durum, taşma yok", async ({ page }) => {
      if (SHOTS) mkdirSync(SHOTS, { recursive: true });
      const shot = async (name: string) => { if (SHOTS) await snap(page, join(SHOTS, `${name}-${vp}-${scheme}.png`)); };
      await prepare(page, scheme);
      await page.clock.setFixedTime(new Date("2026-11-13T12:00:00.000Z"));
      const calls = await mockApi(page);
      await page.goto(`${UI_LAB}/settings/models`);
      const root = page.getByTestId("models-page");
      await expect(root.getByRole("heading", { level: 1, name: "Modeller ve bağlantılar" })).toBeVisible();
      await expect(page.getByTestId("models-list")).toBeVisible();

      // Dolu satır: kaynak, sağlayıcı, erişim (kip null → Bilinmiyor), maliyet metni sayıya biçimlenir.
      const byok = page.getByTestId("model-row-claude-sonnet-5");
      await expect(byok).toContainText("Kendi API anahtarın");
      await expect(byok).toContainText("anthropic");
      // BRA-P0-06a: kaynak byok → BYOK rozeti; platform (M_ZERO) ve bilinmeyen (M_UNKNOWN) kaynak → rozet yok.
      await expect(page.getByTestId("model-badge-claude-sonnet-5-byok")).toHaveText("BYOK");
      await expect(page.getByTestId("model-row-gpt-zero").locator('[data-testid^="model-badge-"]')).toHaveCount(0);
      await expect(page.getByTestId("model-row-yerel-llama").locator('[data-testid^="model-badge-"]')).toHaveCount(0);
      await expect(page.getByTestId("model-access-claude-sonnet-5")).toHaveText("Erişim: bu şirket · Bilinmiyor");
      await expect(page.getByTestId("model-cost-claude-sonnet-5")).toContainText(/1[.,]2345/);
      await expect(page.getByTestId("model-runs-claude-sonnet-5")).toHaveText("Bu ay koşu: 7");

      // API-02 null alanları: arayüz uydurmaz, "Bilinmiyor" der (sağlayıcı, kaynak, erişim, maliyet, koşu).
      const unk = page.getByTestId("model-row-yerel-llama");
      await expect(unk).toContainText("Kaynak: Bilinmiyor");
      await expect(unk).toContainText("Sağlayıcı: Bilinmiyor");
      await expect(page.getByTestId("model-access-yerel-llama")).toHaveText("Erişim: Bilinmiyor · Bilinmiyor");
      await expect(page.getByTestId("model-cost-yerel-llama")).toHaveText("Bu ay maliyet: Bilinmiyor");
      await expect(page.getByTestId("model-runs-yerel-llama")).toHaveText("Bu ay koşu: Bilinmiyor");
      await expect(page.getByTestId("models-auto")).toContainText("Bilinmiyor"); // autoSelection.enabled null

      // Sıfır maliyet BİLİNMİYOR değildir.
      await expect(page.getByTestId("model-cost-gpt-zero")).not.toContainText("Bilinmiyor");
      await expect(page.getByTestId("model-runs-gpt-zero")).toHaveText("Bu ay koşu: 0");

      // Maliyet atfı ve pencere notu görünür.
      await expect(page.getByTestId("models-cost-note")).toContainText("ajanın şu anki modeline");
      await expect(page.getByTestId("models-cost-note")).toContainText("1 Kas 2026");
      await shot("01-liste");

      // Bağlantılar mevcut sayfalara gider (yeni mutasyon yok).
      await expect(page.getByTestId("models-link-compare")).toHaveAttribute("href", "/compare");
      await expect(page.getByTestId("models-link-own")).toHaveAttribute("href", "/settings");

      // Şirket değişimi: o şirketin ucu çağrılır, eski satırlar kalmaz; otomatik seçim true → Açık; boş durum.
      await page.getByTestId("models-company").selectOption("c2");
      await expect(page.getByTestId("models-empty")).toBeVisible();
      await expect(page.getByTestId("model-row-claude-sonnet-5")).toHaveCount(0);
      await expect(page.getByTestId("models-auto")).toContainText("Açık");
      await shot("02-bos");

      // Çok uzun şirket adı seçiciyi taşırmaz; sıfırdan büyük ama 4 ondalığın altındaki maliyet "$0,00" görünmez.
      await page.getByTestId("models-company").selectOption("c3");
      await expect(page.getByTestId("model-row-mini-model")).toBeVisible();
      await expect(page.getByTestId("model-cost-mini-model")).toContainText("< ");
      await expect(page.getByTestId("model-cost-mini-model")).not.toHaveText(/^Bu ay maliyet: \$?0[.,]00\s*\$?$/);
      await expect(page.getByTestId("model-access-mini-model")).toHaveText("Erişim: tek ajan · okuma");
      await shot("03-uzun-ad-kucuk-maliyet");
      expect(calls.filter((c) => c.path === "/companies/c1/models").length).toBeGreaterThan(0);
      expect(calls.filter((c) => c.path === "/companies/c2/models").length).toBeGreaterThan(0);

      // Salt-okur: sayfa GET dışında istek atmaz (kabuğun varlık sinyali `/collaboration/*` bu sayfanın işi değildir).
      expect(calls.filter((c) => c.method !== "GET" && c.method !== "OPTIONS" && !c.path.startsWith("/collaboration/"))).toEqual([]);

      // 390px ve masaüstünde yatay taşma yok.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow).toBe(false);
    });
  });
}

test.describe("bayrak AÇIK: model modu rozeti", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("local → LOCAL rozeti; otomatik seçim AÇIK iken rozet eklenmez (COMPARE yok), platform rozetsiz", async ({ page }) => {
    await prepare(page, "dark");
    await mockApi(page, { companies: [{ id: "c4", name: "Rozet" }] });
    await page.goto(`${UI_LAB}/settings/models`);
    await expect(page.getByTestId("models-auto")).toContainText("Açık");
    await expect(page.getByTestId("model-badge-mini-model-local")).toHaveText("YEREL");
    await expect(page.getByTestId("model-badge-claude-sonnet-5-byok")).toHaveText("BYOK");
    await expect(page.getByTestId("model-row-gpt-zero").locator('[data-testid^="model-badge-"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="model-badge-"][data-testid$="-compare"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="model-badge-"]')).toHaveCount(2);
  });
});

test.describe("bayrak AÇIK: hata ve yarış", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("model ucu 500 → uyarı + yeniden dene; yeniden deneyince liste gelir", async ({ page }) => {
    await prepare(page, "dark");
    const opts: MockOpts = { modelsStatus: { c1: 500 } };
    await mockApi(page, opts);
    await page.goto(`${UI_LAB}/settings/models`);
    const err = page.getByTestId("models-error");
    await expect(err).toBeVisible();
    await expect(err).toContainText("Modeller yüklenemedi");
    expect(await page.getByTestId("models-list").count()).toBe(0);
    delete opts.modelsStatus;
    await err.getByRole("button", { name: "Yeniden dene" }).click();
    await expect(page.getByTestId("models-list")).toBeVisible();
    await expect(page.getByTestId("models-error")).toHaveCount(0);
    // BRA-UX-05h-b: odak body'ye düşmez, sonuç alanında kalır
    await expect(page.getByTestId("models-results")).toBeFocused();
  });

  test("şirket yoksa dürüst boş durum; model ucu çağrılmaz", async ({ page }) => {
    await prepare(page, "dark");
    const calls = await mockApi(page, { companies: [] });
    await page.goto(`${UI_LAB}/settings/models`);
    await expect(page.getByTestId("models-no-company")).toBeVisible();
    expect(calls.filter((c) => /\/models$/.test(c.path))).toEqual([]);
  });

  test("yavaş eski şirket yanıtı, sonradan seçilen şirketin listesini ezmez", async ({ page }) => {
    await prepare(page, "dark");
    await mockApi(page, { modelsDelayMs: { c1: 1500 } });
    await page.goto(`${UI_LAB}/settings/models`);
    await page.getByTestId("models-company").selectOption("c3"); // c1 hâlâ yolda
    await expect(page.getByTestId("model-row-yerel-llama")).toBeVisible();
    await page.waitForTimeout(1900);
    await expect(page.getByTestId("model-row-claude-sonnet-5")).toHaveCount(0);
    await expect(page.getByTestId("model-row-yerel-llama")).toBeVisible();
  });
});

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { UI, UI_LAB } from "./ports";

/**
 * BRA-UX-05b — Birleşik çalışma alanı: iş sayfasında (`/runs/[id]`) kip morfu Özet → Çıktı → Kaput
 * (bayrak `NEXT_PUBLIC_UX_WORKSPACE`, varsayılan KAPALI). Sohbet kipi KAPSAM DIŞI (sohbet ucu yok).
 *
 * İki sunucu AYNI derlemeyi sunar (playwright.config.ts): `UI` bayrak KAPALI, `UI_LAB` bayrak AÇIK (istek anında okunur).
 * API tarayıcıda `page.route` ile taklit edilir (Postgres/API gerekmez).
 *
 *  1. EŞİTLİK: bayrak kapalıyken `/runs/[id]` BU BİLETTEN ÖNCEKİ ekrandır. `e2e/golden/run-detail-legacy.json` UX-05b öncesi
 *     derlemeden (main `176c3f4`) alınmış normalize `#main-content` HTML'idir; kapalı sunucu ile birebir eşit olmalı.
 *     Altın dosyayı yenilemek bilinçli bir işlemdir: `UX_WORKSPACE_UPDATE_GOLDEN=1` (yalnız eski ekranı değiştiren bilet yapar).
 *  2. Bayrak açıkken: tek başlık, üç kip, Sade/Tam, eylemler, "tam ayrıntı" bağlantısı.
 *
 * `UX_WORKSPACE_SCREEN_DIR` verilirse ekran görüntüleri (1440×900 + 390×844 × açık/koyu) kaydedilir.
 */
const SHOTS = process.env.UX_WORKSPACE_SCREEN_DIR;
const GOLDEN = join(__dirname, "golden", "run-detail-legacy.json");
/** `NEXT_PUBLIC_API_URL` derleme anında gömülür (yerelde varsayılan localhost:8080, CI'da operator adresi): ikisi de yakalanır. */
const isApi = (url: URL) => url.pathname.startsWith("/api/v1/") && (url.hostname === "api.operator.example" || url.host === "localhost:8080");

const T0 = "2026-11-11T09:00:00.000Z";
const RUN = {
  id: "r1", pipelineId: "p-r1", status: "RUNNING", state: "RUNNING", resultStatus: null, costUsd: 0.42, budgetUsd: 5,
  startedAt: T0, createdAt: T0, updatedAt: T0, bucket: "working", error: null,
  pipeline: { id: "p-r1", name: "Rapor taslağı", company: { id: "c1", name: "Atölye" } },
  steps: [
    { id: "s1", stepIndex: 0, name: "Kaynakları topla", agentRole: "researcher", status: "COMPLETED", costUsd: 0.1, startedAt: T0, completedAt: T0, durationMs: 900, toolCalls: [{ id: "t1", toolName: "read", status: "COMPLETED", durationMs: 120 }] },
    { id: "s2", stepIndex: 1, name: "Taslağı yaz", agentRole: "writer", status: "RUNNING", costUsd: 0.32, startedAt: T0, toolCalls: [] },
  ],
  approvals: [],
};

type Calls = { method: string; path: string; body: unknown }[];
interface MockOpts { runFail?: boolean; actionStatus?: number; receipt?: "ok" | "none" | "fail"; run?: Record<string, unknown> }

/** Tarayıcıdaki API çağrılarını yakalar; bilinmeyen uçlara boş yanıt (ekranın yan istekleri için). */
async function mockApi(page: Page, opts: MockOpts = {}): Promise<Calls> {
  const calls: Calls = [];
  await page.route(isApi, async (route: Route) => {
    const req = route.request();
    const origin = req.headers().origin ?? UI;
    const cors = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api\/v1/, "");
    let body: unknown = null;
    try { body = req.postDataJSON(); } catch { body = null; }
    calls.push({ method: req.method(), path: path + url.search, body });
    const json = (status: number, data: unknown) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(data) });
    if (/^\/runs\/[^/]+\/(pause|resume|stop|retry)$/.test(path)) return json(opts.actionStatus ?? 200, opts.actionStatus && opts.actionStatus >= 400 ? { error: "no" } : {});
    if (/^\/runs\/[^/]+\/handoffs$/.test(path)) return json(200, { handoffs: [{ id: "h1" }] });
    if (/^\/runs\/[^/]+\/receipt$/.test(path)) {
      if (opts.receipt === "ok") return json(200, { runId: "r1", resultStatus: "VERIFIED", outcome: "COMPLETED", costUsd: 0.42, evidence: [{ kind: "tool", ref: "slack.post", ok: true }] });
      return json(opts.receipt === "fail" ? 500 : 404, { error: "none" });
    }
    if (/^\/runs\/[^/]+$/.test(path) && req.method() === "GET") return opts.runFail ? json(500, { error: "boom" }) : json(200, { ...RUN, ...(opts.run ?? {}) });
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

/** `useId` kimlikleri derlemeler arası değişebilir: karşılaştırmadan önce normalize edilir. */
const normalize = (html: string) => html
  .replace(/(:r[0-9a-z]+:|_r_[0-9a-z]+_|«r[0-9a-z]+»)/g, "ID")
  // BrandMotion sprite karesi zamanla değişir (animasyon karesi, içerik değil): kare konumu normalize edilir.
  .replace(/background-position: [0-9.]+% 0%/g, "background-position: FRAME")
  .replace(/\s+/g, " ").trim();

test.use({ locale: "tr-TR", timezoneId: "UTC" });

test.describe("bayrak KAPALI: /runs/[id] eski ekranla birebir", () => {
  test("altın #main-content HTML'i eşit; yeni bileşenler yok", async ({ page }) => {
    await prepare(page, "dark");
    await page.clock.setFixedTime(new Date("2026-11-11T12:00:00.000Z"));
    const calls = await mockApi(page);
    await page.goto(`${UI}/runs/r1`);
    await expect(page.getByRole("heading", { name: "Adımlar" })).toBeVisible();
    await expect(page.getByText("Harcama dağılımı")).toBeVisible();
    await page.waitForTimeout(600);
    const html = normalize(await page.locator("#main-content").evaluate((el) => el.outerHTML));

    expect(await page.getByTestId("job-workspace").count()).toBe(0);
    expect(calls.filter((c) => c.method === "GET" && c.path === "/runs/r1").length).toBeGreaterThan(0);

    if (process.env.UX_WORKSPACE_UPDATE_GOLDEN === "1") {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, JSON.stringify({ source: "main 176c3f4 (UX-05b öncesi)", running: html }, null, 2) + "\n");
      return;
    }
    expect(existsSync(GOLDEN), "altın dosya yok: önce UX_WORKSPACE_UPDATE_GOLDEN=1 ile ESKİ derlemede üret").toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as { running: string };
    expect(html).toBe(golden.running);
  });

  test("bayrak kapalı ve açık sunucuda oturumsuz /runs/r1 aynı davranır (login'e yönlenir)", async ({ page }) => {
    await page.setExtraHTTPHeaders({ "X-Forwarded-Proto": "https" });
    for (const base of [UI, UI_LAB]) {
      const res = await page.goto(`${base}/runs/r1`);
      await page.waitForURL(/\/login/);
      expect(res?.status()).toBeLessThan(500);
    }
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
const ws = (page: Page) => page.getByTestId("job-workspace");
const snap = async (page: Page, file: string) => { await page.waitForTimeout(450); await page.screenshot({ path: file }); };

for (const { vp, size, scheme } of COMBOS) {
  test.describe(`bayrak AÇIK: iş sayfası (${vp}, ${scheme})`, () => {
    test.use({ viewport: size });

    test("tek başlık altında kip morfu Özet → Çıktı → Kaput, Sade/Tam, klavye, Duraklat, Yönlendir", async ({ page }) => {
      if (SHOTS) mkdirSync(SHOTS, { recursive: true });
      const shot = async (name: string) => { if (SHOTS) await snap(page, join(SHOTS, `${name}-${vp}-${scheme}.png`)); };
      await prepare(page, scheme);
      const calls = await mockApi(page, { receipt: "ok" });
      await page.goto(`${UI_LAB}/runs/r1`);
      await expect(ws(page)).toBeVisible();
      const h1 = ws(page).getByRole("heading", { name: "Rapor taslağı", level: 1 });
      await expect(h1).toBeFocused();
      await expect(ws(page)).toContainText("Atölye · çalışıyor");
      await expect(ws(page).getByRole("tab")).toHaveCount(3); // Özet/Çıktı/Kaput; sohbet kipi YOK
      await expect(ws(page)).not.toContainText(/sohbet|yakında/i);
      await expect(ws(page).getByRole("tab", { name: "Özet", selected: true })).toBeVisible();
      await expect(page.getByTestId("job-workspace").locator("#job-tabpanel")).toContainText("0,42");
      await shot("01-ozet");

      // Çıktı: makbuz yüklenir; başlık aynı kalır (morf: içerik değişir, çerçeve değişmez)
      await ws(page).getByRole("tab", { name: "Çıktı" }).click();
      await expect(ws(page).getByRole("tab", { name: "Çıktı", selected: true })).toBeVisible();
      await expect(h1).toBeVisible();
      await expect.poll(() => calls.some((c) => c.path === "/runs/r1/receipt")).toBe(true);
      await expect(ws(page).locator("#job-tabpanel")).toContainText("DOĞRULANDI");
      await expect(ws(page).locator("#job-tabpanel")).toContainText("slack.post");
      await shot("02-cikti");

      // Kaput: adımlar + araç çağrısı + el değiştirme; Tam kipte maliyet/araç satırları
      await ws(page).getByRole("tab", { name: "Kaput" }).click();
      await expect(ws(page).getByTestId("job-kaput")).toContainText("Kaynakları topla");
      await expect(ws(page).getByTestId("job-kaput")).toContainText("Taslağı yaz");
      await expect(ws(page).getByTestId("job-kaput")).toContainText("El değiştirme: 1");
      await expect(ws(page).getByTestId("job-kaput")).not.toContainText("read ·");
      await ws(page).getByLabel("Ayrıntı").selectOption("full");
      await expect(ws(page).getByTestId("job-kaput")).toContainText("read · completed");
      await shot("03-kaput-tam");
      await ws(page).getByLabel("Ayrıntı").selectOption("simple");

      // Klavye: sağ/sol ok kipler arasında geçer
      await ws(page).getByRole("tab", { name: "Kaput" }).focus();
      await page.keyboard.press("ArrowLeft");
      await expect(ws(page).getByRole("tab", { name: "Çıktı", selected: true })).toBeFocused();
      await page.keyboard.press("Home");
      await expect(ws(page).getByRole("tab", { name: "Özet", selected: true })).toBeFocused();

      // Eylem: Duraklat → POST + iş sayfası tazelenir (yönlendirme yok)
      const before = calls.filter((c) => c.method === "GET" && c.path === "/runs/r1").length;
      await ws(page).getByRole("button", { name: "Duraklat" }).click();
      await expect(ws(page).getByRole("status")).toContainText("Eylem gönderildi.");
      expect(calls.filter((c) => c.method === "POST" && c.path === "/runs/r1/pause")).toHaveLength(1);
      await expect.poll(() => calls.filter((c) => c.method === "GET" && c.path === "/runs/r1").length).toBeGreaterThan(before);
      await expect(ws(page)).toBeVisible();

      // Yönlendir
      await ws(page).getByRole("button", { name: "Yönlendir" }).click();
      await ws(page).getByLabel("Ajana mesaj").fill("Önce özet yaz");
      await ws(page).getByRole("button", { name: "Gönder" }).click();
      await expect(ws(page).getByRole("status")).toContainText("Mesaj gönderildi.");
      expect(calls.find((c) => c.path === "/runs/r1/steer")?.body).toMatchObject({ content: "Önce özet yaz" });
      await shot("04-eylem");
    });
  });
}

test.describe("bayrak AÇIK: kenar durumları", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("başarısız eylem hata duyurur (alert), iş sayfası yerinde kalır", async ({ page }) => {
    await prepare(page, "dark");
    await mockApi(page, { actionStatus: 409 });
    await page.goto(`${UI_LAB}/runs/r1`);
    await ws(page).getByRole("button", { name: "Durdur" }).click();
    await expect(ws(page).getByRole("alert")).toContainText("İşin durumu değişti ya da bir onay bekliyor.");
    await expect(ws(page).getByRole("heading", { name: "Rapor taslağı", level: 1 })).toBeVisible();
  });

  test("iş okunamazsa hata + Yeniden dene; yanıt gelince iş görünür", async ({ page }) => {
    await prepare(page, "dark");
    let fail = true;
    await mockApi(page, { run: {} });
    await page.route(isApi, async (route) => {
      const u = new URL(route.request().url());
      if (fail && /\/runs\/r1$/.test(u.pathname) && route.request().method() === "GET") {
        return route.fulfill({ status: 500, headers: { "access-control-allow-origin": route.request().headers().origin ?? UI_LAB, "access-control-allow-credentials": "true", "content-type": "application/json" }, body: "{\"error\":\"boom\"}" });
      }
      return route.fallback();
    });
    await page.goto(`${UI_LAB}/runs/r1`);
    await expect(ws(page).getByRole("alert")).toContainText("İş açılamadı");
    fail = false;
    await ws(page).getByRole("button", { name: "Yeniden dene" }).click();
    await expect(ws(page).getByRole("heading", { name: "Rapor taslağı", level: 1 })).toBeVisible();
  });

  test("bulunamayan iş (404) nazik mesaj verir", async ({ page }) => {
    await prepare(page, "dark");
    await mockApi(page);
    await page.route(isApi, async (route) => {
      const u = new URL(route.request().url());
      if (/\/runs\/r1$/.test(u.pathname) && route.request().method() === "GET") {
        return route.fulfill({ status: 404, headers: { "access-control-allow-origin": route.request().headers().origin ?? UI_LAB, "access-control-allow-credentials": "true", "content-type": "application/json" }, body: "{\"error\":\"none\"}" });
      }
      return route.fallback();
    });
    await page.goto(`${UI_LAB}/runs/r1`);
    await expect(ws(page).getByRole("alert")).toContainText("Bu iş bulunamadı");
  });

  test("klasik görünüm bağlantısı bayrak açıkken eski ayrıntı sayfasını verir", async ({ page }) => {
    await prepare(page, "dark");
    await mockApi(page);
    await page.goto(`${UI_LAB}/runs/r1`);
    await ws(page).getByRole("link", { name: "Klasik ayrıntı görünümü" }).click();
    await page.waitForURL(/\/runs\/r1\?view=classic/);
    await expect(page.getByRole("heading", { name: "Adımlar" })).toBeVisible();
    expect(await ws(page).count()).toBe(0);
  });

  test("İşler çekmecesindeki 'Tüm ayrıntı sayfasını aç' bağlantısı iş sayfasına açılır", async ({ page }) => {
    await prepare(page, "dark");
    await mockApi(page);
    await page.route(isApi, async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith("/runs") && route.request().method() === "GET") {
        return route.fulfill({ status: 200, headers: { "access-control-allow-origin": route.request().headers().origin ?? UI_LAB, "access-control-allow-credentials": "true", "content-type": "application/json" }, body: JSON.stringify({ runs: [{ ...RUN, bucket: "working" }], nextCursor: null }) });
      }
      return route.fallback();
    });
    await page.goto(`${UI_LAB}/inbox`);
    await page.getByTestId("job-row").first().getByRole("button", { name: /Rapor taslağı/ }).click();
    await page.getByTestId("job-drawer").getByRole("link", { name: "Tüm ayrıntı sayfasını aç" }).click();
    await page.waitForURL(/\/runs\/r1$/);
    await expect(ws(page)).toBeVisible();
  });
});

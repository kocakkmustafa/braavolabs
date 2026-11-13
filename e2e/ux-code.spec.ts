import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { UI_LAB, UI_WS } from "./ports";

/**
 * BRA-UX-05e — "Kod değişikliğini incele" kartı (Çıktı sekmesi; bayrak `NEXT_PUBLIC_UX_CODE`, varsayılan KAPALI). Yalnız okur.
 * Sunucular AYNI derlemeyi sunar: `UI_WS` İşler + iş sayfası AÇIK ama kod bayrağı KAPALI (kart yok, `/code-summary` isteği yok),
 * `UI_LAB` hepsi AÇIK. API tarayıcıda `page.route` ile taklit edilir. `UX_CODE_SCREEN_DIR` verilirse ekranlar kaydedilir.
 */
const SHOTS = process.env.UX_CODE_SCREEN_DIR;
const isApi = (url: URL) => url.pathname.startsWith("/api/v1/") && (url.hostname === "api.operator.example" || url.host === "localhost:8080");

const T0 = "2026-11-13T09:00:00.000Z";
const RUN = {
  id: "r1", pipelineId: "p-r1", status: "COMPLETED", state: "COMPLETED", resultStatus: "VERIFIED", costUsd: 0.42, budgetUsd: 5,
  startedAt: T0, createdAt: T0, updatedAt: T0, bucket: "done", error: null,
  pipeline: { id: "p-r1", name: "Login hatası düzeltmesi", company: { id: "c1", name: "Atölye" } }, steps: [], approvals: [],
};
const FULL = {
  runId: "r1", generatedAt: T0,
  diff: { files: [{ path: "src/auth.ts", additions: 12, deletions: 4 }, { path: "src/session.ts", additions: 3, deletions: 0 }, { path: "src/çok/uzun/dizin/yolu/bir/dosya/adi/ile/taşma/denemesi/yapan/dosya.test.ts", additions: 1, deletions: 1 }], fileCount: 3, additions: 16, deletions: 5, complete: true },
  tests: { passed: 41, failed: 0, skipped: 0, total: 41, ok: true, runs: 1 },
};
const PARTIAL = {
  runId: "r1", generatedAt: T0,
  diff: { files: [{ path: "a.ts", additions: 12, deletions: 4 }, { path: "b.ts", additions: null, deletions: null }], fileCount: 5, additions: 12, deletions: 4, complete: false },
  tests: { passed: 38, failed: 3, skipped: 2, total: null, ok: false, runs: 3 },
};

type Calls = { method: string; path: string }[];
interface MockOpts { summary?: { status: number; body?: unknown }; run?: Record<string, unknown> }

async function mockApi(page: Page, opts: MockOpts = {}): Promise<Calls> {
  const calls: Calls = [];
  await page.route(isApi, async (route: Route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": req.headers().origin ?? UI_LAB, "access-control-allow-credentials": "true", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api\/v1/, "");
    calls.push({ method: req.method(), path: path + url.search });
    const json = (status: number, data: unknown) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(data) });
    if (path === "/runs" && req.method() === "GET") return json(200, { runs: url.searchParams.get("bucket") === "working" ? [{ ...RUN, ...(opts.run ?? {}) }] : [], nextCursor: null });
    if (/^\/runs\/[^/]+\/code-summary$/.test(path)) return json(opts.summary?.status ?? 200, opts.summary?.body ?? FULL);
    if (/^\/runs\/[^/]+\/receipt$/.test(path)) return json(200, { runId: "r1", resultStatus: "VERIFIED", outcome: "COMPLETED", costUsd: 0.42, evidence: [{ kind: "tool", ref: "slack.post", ok: true }] });
    if (/^\/runs\/[^/]+$/.test(path) && req.method() === "GET") return json(200, { ...RUN, ...(opts.run ?? {}) });
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
const ws = (page: Page) => page.getByTestId("job-workspace");
const openOutput = async (page: Page, base: string) => {
  await page.goto(`${base}/runs/r1`);
  await expect(ws(page)).toBeVisible();
  await ws(page).getByRole("tab", { name: "Çıktı" }).click();
};
const snap = async (page: Page, file: string) => { await page.waitForTimeout(300); await page.screenshot({ path: file }); };
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);

test.describe("bayrak KAPALI (iş sayfası açık): kart yok, /code-summary isteği yok", () => {
  test("Çıktı sekmesi makbuzu gösterir, kod kartı ve istek yok", async ({ page }) => {
    await prepare(page, "dark");
    const calls = await mockApi(page);
    await openOutput(page, UI_WS);
    await expect(ws(page).locator("#job-tabpanel")).toContainText("slack.post");
    await page.waitForTimeout(800);
    expect(await page.getByTestId("code-change").count()).toBe(0);
    expect(calls.filter((c) => c.path.includes("code-summary"))).toEqual([]);
    expect(calls.some((c) => c.path === "/runs/r1/receipt")).toBe(true);
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

for (const { vp, size, scheme } of COMBOS) {
  test.describe(`bayrak AÇIK: kod kartı (${vp}, ${scheme})`, () => {
    test.use({ viewport: size });

    test("hazır kart: dosyalar, +/−, testler, Kabul/Reddet yok, taşma yok", async ({ page }) => {
      if (SHOTS) mkdirSync(SHOTS, { recursive: true });
      await prepare(page, scheme);
      const calls = await mockApi(page);
      await openOutput(page, UI_LAB);
      const card = page.getByTestId("code-change");
      await expect(card.getByRole("heading", { level: 2, name: "Değişiklik: Login hatası düzeltmesi" })).toBeVisible();
      await expect(card.getByTestId("code-file")).toHaveCount(3);
      await expect(card.getByTestId("code-file").first()).toContainText("src/auth.ts");
      await expect(card.getByTestId("code-file").first()).toContainText("+12");
      await expect(card.getByTestId("code-file").first()).toContainText("−4");
      await expect(card.getByTestId("code-totals")).toHaveText("Toplam: +16 −5");
      await expect(card.getByTestId("code-tests")).toContainText("41 geçti · 0 kaldı");
      await expect(card.getByTestId("code-tests-ok")).toBeVisible();
      await expect(card.getByRole("button")).toHaveCount(0); // Kabul et / Reddet yok
      await expect(card).not.toContainText(/Kabul|Reddet|yakında/i);
      await expect(page.getByTestId("code-approvals-link")).toHaveCount(0); // iş bitti
      await expect(page.getByTestId("code-live")).toContainText("Dosyalar (3), +16 −5");
      if (SHOTS) await snap(page, join(SHOTS, `01-hazir-${vp}-${scheme}.png`));
      expect(calls.filter((c) => c.path.includes("code-summary")).length).toBe(1);
      expect(calls.filter((c) => c.method !== "GET" && c.method !== "OPTIONS" && !c.path.startsWith("/collaboration/"))).toEqual([]);
      await noOverflow(page);
      // 44px dokunma hedefi: açılır liste başlığı
      const box = await card.locator("summary").boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    });
  });
}

test.describe("bayrak AÇIK: kısmi, hata, kayıt yok, onay bekliyor", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("null → Bilinmiyor, complete:false → en az, ok:false → Doğrulanmadı, kırpılmış liste, N koşu", async ({ page }) => {
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    await prepare(page, "dark");
    await mockApi(page, { summary: { status: 200, body: PARTIAL } });
    await openOutput(page, UI_LAB);
    const card = page.getByTestId("code-change");
    await expect(card.getByTestId("code-totals")).toHaveText("En az: +12 −4");
    await expect(card.getByTestId("code-partial")).toBeVisible();
    await expect(card.getByTestId("code-file").nth(1)).toContainText("Bilinmiyor Bilinmiyor");
    await expect(card.getByTestId("code-more")).toHaveText("+3 dosya daha");
    await expect(card.getByTestId("code-tests")).toContainText("38 geçti · 3 kaldı · 2 atlandı");
    await expect(card.getByTestId("code-tests-unverified")).toContainText("Doğrulanmadı");
    await expect(card.getByTestId("code-tests-runs")).toHaveText("3 test koşusu");
    if (SHOTS) await snap(page, join(SHOTS, "02-kismi-mobil-390-dark.png"));
    await noOverflow(page);
  });

  test("hata → Yeniden dene çalışır; ikisi null → kayıt yok", async ({ page }) => {
    await prepare(page, "dark");
    const opts: MockOpts = { summary: { status: 500 } };
    const calls = await mockApi(page, opts);
    await openOutput(page, UI_LAB);
    const card = page.getByTestId("code-change");
    await expect(card.getByRole("alert")).toContainText("Kod değişikliği yüklenemedi");
    opts.summary = { status: 200, body: { runId: "r1", diff: null, tests: null, generatedAt: T0 } };
    await card.getByRole("button", { name: "Yeniden dene" }).click();
    await expect(page.getByTestId("code-none")).toHaveText("Bu işte kod değişikliği kaydı yok.");
    expect(calls.filter((c) => c.path.includes("code-summary")).length).toBe(2);
    if (SHOTS) await snap(page, join(SHOTS, "03-kayit-yok-mobil-390-dark.png"));
  });

  test("onay bekleyen koşu: /approvals bağlantısı, başka eylem yok", async ({ page }) => {
    await prepare(page, "light");
    await mockApi(page, { run: { bucket: "needs_approval", status: "RUNNING", state: "NEEDS_APPROVAL", resultStatus: null } });
    await openOutput(page, UI_LAB);
    const link = page.getByTestId("code-approvals-link");
    await expect(link).toHaveAttribute("href", "/approvals");
    await expect(link).toHaveText("Onay merkezinde karar ver");
    await expect(page.getByTestId("code-change").getByRole("button")).toHaveCount(0);
    if (SHOTS) await snap(page, join(SHOTS, "04-onay-bekliyor-mobil-390-light.png"));
  });
});

const drawerOutput = async (page: Page, base: string) => {
  await page.goto(`${base}/inbox`);
  const row = page.getByTestId("job-row").first();
  await expect(row).toContainText("Login hatası düzeltmesi");
  await row.getByRole("button", { name: /Login hatası/ }).click();
  const drawer = page.getByTestId("job-drawer");
  await expect(drawer).toBeVisible();
  await drawer.getByRole("tab", { name: "Çıktı" }).click();
  return drawer;
};

test.describe("İşler çekmecesi yolu", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  const RUNNING = { status: "RUNNING", state: "RUNNING", resultStatus: null, bucket: "working" };

  test("bayrak KAPALI sunucuda çekmecede kart ve /code-summary isteği yok", async ({ page }) => {
    await prepare(page, "dark");
    const calls = await mockApi(page, { run: RUNNING });
    const drawer = await drawerOutput(page, UI_WS);
    await expect(drawer.getByRole("tabpanel")).toContainText("slack.post");
    await page.waitForTimeout(800);
    expect(await page.getByTestId("code-change").count()).toBe(0);
    expect(calls.filter((c) => c.path.includes("code-summary"))).toEqual([]);
  });

  test("bayrak AÇIK sunucuda çekmecede kart var (h3), istek 1 kez", async ({ page }) => {
    await prepare(page, "dark");
    const calls = await mockApi(page, { run: RUNNING });
    const drawer = await drawerOutput(page, UI_LAB);
    const card = drawer.getByTestId("code-change");
    await expect(card.getByRole("heading", { level: 3, name: "Değişiklik: Login hatası düzeltmesi" })).toBeVisible();
    await expect(card.getByTestId("code-tests")).toContainText("41 geçti");
    expect(calls.filter((c) => c.path.includes("code-summary")).length).toBe(1);
  });

  test("çekmecede onay bekleyen koşu (state null, status WAITING_APPROVAL): onay merkezi bağlantısı", async ({ page }) => {
    await prepare(page, "dark");
    await mockApi(page, { run: { status: "WAITING_APPROVAL", state: null, resultStatus: null, bucket: "working" } });
    const drawer = await drawerOutput(page, UI_LAB);
    await expect(drawer.getByTestId("code-approvals-link")).toHaveAttribute("href", "/approvals");
  });
});

test.describe("sessiz yenileme", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Çıktı açıkken iş güncellenince özet yeniden çekilir; önceki veri yerinde kalır (yükleniyor yok)", async ({ page }) => {
    await prepare(page, "dark");
    await page.clock.install({ time: new Date("2026-11-13T12:00:00.000Z") });
    const opts: MockOpts = { run: { status: "RUNNING", state: "RUNNING", resultStatus: null, bucket: "working" } };
    const calls = await mockApi(page, opts);
    await openOutput(page, UI_LAB);
    const card = page.getByTestId("code-change");
    await expect(card.getByTestId("code-tests")).toContainText("41 geçti");
    expect(calls.filter((c) => c.path.includes("code-summary")).length).toBe(1);
    await page.evaluate(() => {
      (window as any).__sawLoading = false;
      new MutationObserver(() => { if (document.querySelector("[data-testid=code-change]")?.textContent?.includes("yükleniyor")) (window as any).__sawLoading = true; })
        .observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    // İş güncellendi (yeni updatedAt + bitti) ve özet değişti.
    opts.run = { status: "COMPLETED", state: "COMPLETED", resultStatus: "VERIFIED", bucket: "done", updatedAt: "2026-11-13T09:30:00.000Z" };
    opts.summary = { status: 200, body: { ...FULL, tests: { ...FULL.tests, passed: 42, total: 42 } } };
    await page.clock.fastForward(10_500);
    await expect(card.getByTestId("code-tests")).toContainText("42 geçti");
    expect(calls.filter((c) => c.path.includes("code-summary")).length).toBe(2);
    expect(await page.evaluate(() => (window as any).__sawLoading)).toBe(false);
  });

  test("sessiz yenileme hatası eski veriyi korur", async ({ page }) => {
    await prepare(page, "dark");
    await page.clock.install({ time: new Date("2026-11-13T12:00:00.000Z") });
    const opts: MockOpts = { run: { status: "RUNNING", state: "RUNNING", resultStatus: null, bucket: "working" } };
    const calls = await mockApi(page, opts);
    await openOutput(page, UI_LAB);
    const card = page.getByTestId("code-change");
    await expect(card.getByTestId("code-tests")).toContainText("41 geçti");
    opts.run = { status: "RUNNING", state: "RUNNING", resultStatus: null, bucket: "working", updatedAt: "2026-11-13T09:45:00.000Z" };
    opts.summary = { status: 500 };
    await page.clock.fastForward(10_500);
    await expect.poll(() => calls.filter((c) => c.path.includes("code-summary")).length).toBe(2);
    await expect(card.getByTestId("code-tests")).toContainText("41 geçti");
    await expect(card.getByRole("alert")).toHaveCount(0);
  });
});

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { UI, UI_LAB } from "./ports";

/**
 * BRA-UX-05a — Başlangıç/Niyet Çubuğu gerçek `/start` ekranında (bayrak `NEXT_PUBLIC_UX_INTENT`, varsayılan KAPALI).
 *
 * İki sunucu AYNI derlemeyi sunar (playwright.config.ts): `UI` bayrak KAPALI, `UI_LAB` bayrak AÇIK (istek anında okunur).
 * API tarayıcıda `page.route` ile taklit edilir (Postgres/API gerekmez): istekler ve gövdeleri doğrulanır.
 *
 *  1. EŞİTLİK: bayrak kapalıyken `/start` yeni ağaç değil, BU BİLETTEN ÖNCEKİ ekrandır. `e2e/golden/start-legacy.json`
 *     UX-05a öncesi derlemeden (main `04d9dc0`) alınmış normalize `<main>` HTML'idir; kapalı sunucu ile birebir eşit olmalı.
 *     Altın dosyayı yenilemek bilinçli bir işlemdir: `UX_INTENT_UPDATE_GOLDEN=1` (yalnız eski ekranı değiştiren bilet yapar).
 *  2. Bayrak açıkken: niyet çubuğu, sınıflayıcı önizlemesi, plan kartı → çalıştır, sohbet (uç YOK), ajan (hemen kaydeder).
 *
 * `UX_INTENT_SCREEN_DIR` verilirse ekran görüntüleri (1440×900 + 390×844 × açık/koyu) kaydedilir.
 */
const SHOTS = process.env.UX_INTENT_SCREEN_DIR;
const GOLDEN = join(__dirname, "golden", "start-legacy.json");
/** `NEXT_PUBLIC_API_URL` derleme anında gömülür (yerelde varsayılan localhost:8080, CI'da operator adresi): ikisi de yakalanır. */
const isApi = (url: URL) => url.pathname.startsWith("/api/v1/") && (url.hostname === "api.operator.example" || url.host === "localhost:8080");

const PLAN_LOW = {
  intent: "job", planHash: "hash-low",
  card: {
    title: "Müşteri e-postalarını özetle", goal: "E-postaları özetleyip taslak olarak kaydet.", risk: "low",
    steps: [
      { title: "Talebi netleştir, kaynak topla", tool: "read", needsApproval: false, risk: "low" },
      { title: "Taslak çıktıyı hazırla", tool: "draft", needsApproval: false, risk: "low" },
      { title: "Sonucu özetle ve sun", tool: "summarize", needsApproval: false, risk: "low" },
    ],
    estimate: { costUsd: { low: 0.02, high: 0.06 }, priced: true },
  },
};
const PLAN_HIGH = {
  intent: "job", planHash: "hash-high",
  card: {
    title: "Ekibe duyuru gönder", goal: "Slack'e duyuru gönder.", risk: "high",
    steps: [{ title: "Slack'e gönder", tool: "slack.post", needsApproval: true, risk: "high" }],
    estimate: { costUsd: { low: null, high: null }, priced: false },
  },
};

type Calls = { method: string; path: string; body: unknown }[];
interface MockOpts { companies?: { id: string; name: string }[]; plan?: unknown; startStatus?: number; startBody?: unknown }

/** Tarayıcıdaki API çağrılarını yakalar: bilinmeyen uçlara boş yanıt (ekranın yan istekleri için). */
async function mockApi(page: Page, opts: MockOpts = {}): Promise<Calls> {
  const calls: Calls = [];
  const companies = opts.companies ?? [{ id: "c1", name: "Atölye" }];
  await page.route(isApi, async (route: Route) => {
    const req = route.request();
    const origin = req.headers().origin ?? UI;
    const cors = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const path = new URL(req.url()).pathname.replace(/^\/api\/v1/, "");
    let body: unknown = null;
    try { body = req.postDataJSON(); } catch { body = null; }
    calls.push({ method: req.method(), path, body });
    const json = (status: number, data: unknown) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(data) });
    if (path === "/companies" && req.method() === "GET") return json(200, companies);
    if (path === "/jobs/plan") return json(200, opts.plan ?? PLAN_LOW);
    if (path === "/jobs/start") return json(opts.startStatus ?? 200, opts.startBody ?? { runId: "run-1", state: "RUNNING" });
    if (/^\/companies\/[^/]+\/agents\/compose$/.test(path)) {
      return json(200, { agent: { id: "a1", name: "Satış ajanı", role: "sales", systemPrompt: "x", tools: ["read"] }, droppedTools: ["slack.post"], provider: "p", model: "m", tokens: { input: 1, output: 1 } });
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

/** `useId` kimlikleri derlemeler arası değişebilir: karşılaştırmadan önce normalize edilir. */
const normalize = (html: string) => html.replace(/(:r[0-9a-z]+:|_r_[0-9a-z]+_|«r[0-9a-z]+»)/g, "ID").replace(/\s+/g, " ").trim();

/** Düğme renk geçişleri (global CSS) bitsin: ekran görüntüsü ara karede alınmasın. */
const snap = async (page: Page, file: string) => { await page.waitForTimeout(450); await page.screenshot({ path: file }); };

test.use({ locale: "tr-TR" });

test.describe("bayrak KAPALI: /start eski ekranla birebir", () => {
  test("altın <main> HTML'i (boşta ve plan kartı) eşit; yeni bileşenler yok", async ({ page }) => {
    await prepare(page, "dark");
    const calls = await mockApi(page);
    await page.goto(`${UI}/start`);
    const main = page.locator("#main-content main"); // kabuğun <main id="main-content"> içindeki sayfa <main>'i
    const box = page.getByLabel("Ne yapılmasını istiyorsun?");
    await box.fill("Müşteri e-postalarını özetle ve taslak olarak kaydet");
    await expect(page.getByRole("button", { name: "Plan öner" })).toBeEnabled(); // şirketler yüklendi
    await box.fill("");
    await expect(page.getByRole("button", { name: "Plan öner" })).toBeDisabled();
    const idle = normalize(await main.evaluate((el) => el.outerHTML));

    await box.fill("Müşteri e-postalarını özetle ve taslak olarak kaydet");
    await page.getByRole("button", { name: "Plan öner" }).click();
    await expect(page.getByRole("heading", { name: "Müşteri e-postalarını özetle" })).toBeVisible();
    const ready = normalize(await main.evaluate((el) => el.outerHTML));

    expect(await page.getByTestId("intent-bar").count()).toBe(0);
    expect(calls.filter((c) => c.path === "/jobs/plan")).toHaveLength(1);
    expect(calls.find((c) => c.path === "/jobs/plan")?.body).toEqual({ message: "Müşteri e-postalarını özetle ve taslak olarak kaydet" });

    if (process.env.UX_INTENT_UPDATE_GOLDEN === "1") {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, JSON.stringify({ source: "main 04d9dc0 (UX-05a öncesi)", idle, ready }, null, 2) + "\n");
      return;
    }
    expect(existsSync(GOLDEN), "altın dosya yok: önce UX_INTENT_UPDATE_GOLDEN=1 ile ESKİ derlemede üret").toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as { idle: string; ready: string };
    expect(idle).toBe(golden.idle);
    expect(ready).toBe(golden.ready);
  });

  test("bayrak kapalı ve açık sunucuda oturumsuz /start aynı davranır (login'e yönlenir)", async ({ page }) => {
    await page.setExtraHTTPHeaders({ "X-Forwarded-Proto": "https" });
    for (const base of [UI, UI_LAB]) {
      const res = await page.goto(`${base}/start`);
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
const JOB_TEXT = "Müşteri e-postalarını özetle ve taslak olarak kaydet";
const AGENT_TEXT = "Satış için bir ajan oluştur";
const bar = (page: Page) => page.getByTestId("intent-bar");

for (const { vp, size, scheme } of COMBOS) {
  test.describe(`bayrak AÇIK: Niyet Çubuğu (${vp}, ${scheme})`, () => {
    test.use({ viewport: size });

    test("iş: tarif → Anladığım: İş → plan kartı → Çalıştır (/jobs/start) → /inbox", async ({ page }) => {
      if (SHOTS) mkdirSync(SHOTS, { recursive: true });
      const shot = async (name: string) => { if (SHOTS) await snap(page, join(SHOTS, `${name}-${vp}-${scheme}.png`)); };
      await prepare(page, scheme);
      const calls = await mockApi(page);
      await page.goto(`${UI_LAB}/start`);
      await expect(page.getByRole("heading", { name: "Başla", level: 1 })).toBeVisible();
      await expect(page.getByLabel("Ne yapmak istiyorsun?")).toBeVisible();
      await expect(bar(page).getByRole("radio", { name: "Sohbet" })).toHaveAttribute("aria-checked", "true");
      await expect(bar(page).getByRole("button", { name: "Sohbet başlat" })).toBeDisabled();
      await shot("01-bos");

      await page.getByLabel("Ne yapmak istiyorsun?").fill(JOB_TEXT);
      await expect(bar(page).getByRole("radio", { name: "İş" })).toHaveAttribute("aria-checked", "true");
      await shot("02-anladigim-is");
      await bar(page).getByRole("button", { name: "Planla" }).click();
      const card = page.getByTestId("intent-plan-card");
      await expect(card).toBeVisible();
      await expect(card).toContainText("Müşteri e-postalarını özetle");
      await expect(card).toContainText("araç: read");
      await expect(card).toContainText("Adım başına model satırı: henüz yok");
      expect(calls.filter((c) => c.path === "/jobs/plan")).toHaveLength(1);
      expect(calls.find((c) => c.path === "/jobs/plan")?.body).toEqual({ message: JOB_TEXT });
      await shot("03-plan-karti");

      await card.getByRole("button", { name: /^Çalıştır/ }).click();
      await page.waitForURL(/\/inbox/);
      const start = calls.filter((c) => c.path === "/jobs/start");
      expect(start).toHaveLength(1);
      expect(start[0].body).toMatchObject({ message: JOB_TEXT, planHash: "hash-low" });
      expect(typeof (start[0].body as { idempotencyKey: unknown }).idempotencyKey).toBe("string");
    });

    test("sohbet: uç yok → dürüst bilgi, plan çağrısı yok; 'İş olarak planla' isteğe bağlı", async ({ page }) => {
      if (SHOTS) mkdirSync(SHOTS, { recursive: true });
      await prepare(page, scheme);
      const calls = await mockApi(page);
      await page.goto(`${UI_LAB}/start`);
      await page.getByLabel("Ne yapmak istiyorsun?").fill("merhaba");
      await bar(page).getByRole("button", { name: "Sohbet başlat" }).click();
      const info = page.getByTestId("intent-chat-unavailable");
      await expect(info).toContainText("Sohbet henüz yok");
      await expect(info).toContainText("harcama yok");
      expect(calls.filter((c) => c.path.startsWith("/jobs/"))).toHaveLength(0);
      if (SHOTS) await snap(page, join(SHOTS, `04-sohbet-${vp}-${scheme}.png`));
      await info.getByRole("button", { name: "İş olarak planla" }).click();
      await expect(page.getByTestId("intent-plan-card")).toBeVisible();
      expect(calls.filter((c) => c.path === "/jobs/plan")).toHaveLength(1);
    });

    test("ajan: çubuk KAYDETMEZ; onay kartı tek adımı söyler; düğmeyle tek compose çağrısı", async ({ page }) => {
      if (SHOTS) mkdirSync(SHOTS, { recursive: true });
      const shot = async (name: string) => { if (SHOTS) await snap(page, join(SHOTS, `${name}-${vp}-${scheme}.png`)); };
      await prepare(page, scheme);
      const calls = await mockApi(page);
      await page.goto(`${UI_LAB}/start`);
      await page.getByLabel("Ne yapmak istiyorsun?").fill(AGENT_TEXT);
      await expect(bar(page).getByRole("radio", { name: "Ajan" })).toHaveAttribute("aria-checked", "true");
      await bar(page).getByRole("button", { name: "Ajan iste" }).click();
      const confirm = page.getByTestId("intent-agent-confirm");
      await expect(confirm).toContainText("ajanı hemen kaydeder");
      expect(calls.filter((c) => c.path.includes("/agents/compose")), "çubuk tek başına ajan kaydetmemeli").toHaveLength(0);
      await shot("05-ajan-onay");
      await confirm.getByRole("button", { name: "Ajanı hemen oluştur" }).click();
      const done = page.getByTestId("intent-agent-done");
      await expect(done).toContainText("Satış ajanı");
      await expect(page.getByTestId("intent-agent-dropped")).toContainText("Çıkarılan araç (1): slack.post");
      const compose = calls.filter((c) => c.path === "/companies/c1/agents/compose");
      expect(compose).toHaveLength(1);
      expect(compose[0].body).toEqual({ description: AGENT_TEXT });
      await shot("06-ajan-sonuc");
    });
  });
}

test.describe("bayrak AÇIK: kenar durumlar", () => {
  test("onay gerektiren iş: 422 high_risk_start_unsupported açıkça gösterilir, düğme gizlenmez ama devre dışı", async ({ page }) => {
    await prepare(page, "dark");
    await mockApi(page, { plan: PLAN_HIGH, startStatus: 422, startBody: { error: "high_risk_start_unsupported" } });
    await page.goto(`${UI_LAB}/start`);
    await page.getByLabel("Ne yapmak istiyorsun?").fill("Ekibe duyuru gönder ve Slack'e yaz hemen");
    await bar(page).getByRole("button", { name: "Planla" }).click();
    const card = page.getByTestId("intent-plan-card");
    await expect(card).toContainText("onay gerekli, yüksek risk");
    await expect(card).toContainText("fiyat bilinmiyor");
    await card.getByRole("button", { name: /^Çalıştır/ }).click();
    await expect(card.getByRole("alert")).toContainText("onay kapısı şu an kapalı");
    await expect(card.getByRole("button", { name: /^Çalıştır/ })).toBeDisabled();
  });

  test("birden çok şirket: seçmeden planlanmaz; seçince workspaceId gider", async ({ page }) => {
    await prepare(page, "dark");
    const calls = await mockApi(page, { companies: [{ id: "c1", name: "Atölye" }, { id: "c2", name: "Mağaza" }] });
    await page.goto(`${UI_LAB}/start`);
    const select = page.getByLabel("Çalışma alanı");
    await expect(select).toBeVisible();
    await page.getByLabel("Ne yapmak istiyorsun?").fill(JOB_TEXT);
    await bar(page).getByRole("button", { name: "Planla" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Önce bir çalışma alanı seç" })).toBeVisible();
    expect(calls.filter((c) => c.path === "/jobs/plan")).toHaveLength(0);
    await select.selectOption("c2");
    await page.getByLabel("Ne yapmak istiyorsun?").fill(JOB_TEXT);
    await bar(page).getByRole("button", { name: "Planla" }).click();
    await expect(page.getByTestId("intent-plan-card")).toBeVisible();
    expect(calls.find((c) => c.path === "/jobs/plan")?.body).toEqual({ message: JOB_TEXT, workspaceId: "c2" });
  });

  test("klavye: radiogroup ok tuşlarıyla gezilir, roving tabindex", async ({ page }) => {
    await prepare(page, "dark");
    await mockApi(page);
    await page.goto(`${UI_LAB}/start`);
    const chat = bar(page).getByRole("radio", { name: "Sohbet" });
    await chat.focus();
    await page.keyboard.press("ArrowRight");
    await expect(bar(page).getByRole("radio", { name: "İş" })).toHaveAttribute("aria-checked", "true");
    await expect(bar(page).getByRole("radio", { name: "İş" })).toBeFocused();
    await expect(bar(page).getByRole("radio", { name: "Sohbet" })).toHaveAttribute("tabindex", "-1");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(bar(page).getByRole("radio", { name: "Ajan" })).toHaveAttribute("aria-checked", "true");
    // Seçimi bırakılan düğmeler aynı çerçeveyi geri almalı (React border/borderColor kısayol hatası regresyonu).
    const border = (name: string) => bar(page).getByRole("radio", { name }).evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(await border("Sohbet")).toBe(await border("İş"));
  });

  test("Enter gönderir, Shift+Enter satır ekler; boşken hiçbir istek gitmez", async ({ page }) => {
    await prepare(page, "dark");
    const calls = await mockApi(page);
    await page.goto(`${UI_LAB}/start`);
    const box = page.getByLabel("Ne yapmak istiyorsun?");
    await box.press("Enter");
    expect(calls.filter((c) => c.path.startsWith("/jobs/"))).toHaveLength(0);
    await box.fill(JOB_TEXT);
    await box.press("Shift+Enter");
    await expect(box).toHaveValue(`${JOB_TEXT}\n`);
    await box.press("Enter");
    await expect(page.getByTestId("intent-plan-card")).toBeVisible();
    expect(calls.filter((c) => c.path === "/jobs/plan")).toHaveLength(1);
  });
});

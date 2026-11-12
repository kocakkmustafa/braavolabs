import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { UI, UI_LAB } from "./ports";

/**
 * BRA-UX-05i — Onay ve güvenlik merkezi: `/approvals` (bayrak `NEXT_PUBLIC_UX_APPROVALS`, varsayılan KAPALI).
 *
 * İki sunucu AYNI derlemeyi sunar (playwright.config.ts): `UI` bayrak KAPALI, `UI_LAB` bayrak AÇIK (istek anında okunur).
 * API tarayıcıda `page.route` ile taklit edilir (Postgres/API gerekmez).
 *
 *  1. EŞİTLİK: bayrak kapalıyken `/approvals` BU BİLETTEN ÖNCEKİ ekrandır. `e2e/golden/approvals-legacy.json` UX-05i öncesi
 *     derlemeden (main `d9c6c58`) alınmış normalize `#main-content` HTML'idir. Yenilemek bilinçli işlemdir: `UX_APPROVALS_UPDATE_GOLDEN=1`.
 *  2. Bayrak açıkken: liste, sheet (düşük risk / tehlikeli ikinci adım / "Bilgi yok"), karar uçları, klavye/odak.
 *
 * `UX_APPROVALS_SCREEN_DIR` verilirse ekran görüntüleri (1440×900 + 390×844 × açık/koyu) kaydedilir.
 */
const SHOTS = process.env.UX_APPROVALS_SCREEN_DIR;
const GOLDEN = join(__dirname, "golden", "approvals-legacy.json");
/** `NEXT_PUBLIC_API_URL` derleme anında gömülür (yerelde varsayılan localhost:8080, CI'da operator adresi): ikisi de yakalanır. */
const isApi = (url: URL) => url.pathname.startsWith("/api/v1/") && (url.hostname === "api.operator.example" || url.host === "localhost:8080");

const T0 = "2026-11-11T09:00:00.000Z";
const run = (id: string) => ({ pipeline: { name: "Haftalık bülten", company: { name: "Atölye" } }, id });
const A_LOW = {
  id: "a1", runId: "run-aaaaaaaa", type: "EXTERNAL_CONTROL", status: "PENDING", description: "Slack'e mesaj gönder", amountUsd: null,
  createdAt: T0, expiresAt: null, metadata: { toolName: "slack.post" }, artifact: null, run: run("run-aaaaaaaa"),
  details: { risk: "low", permissions: ["slack.post:POST"], dataTransfer: ["POST → bağlantı slack-main, hedef genel"], reversible: true },
};
const A_DANGER = {
  id: "a2", runId: "run-bbbbbbbb", type: "SPEND", status: "PENDING", description: "Müşteriye e-posta gönder", amountUsd: "12.50", // Prisma Decimal JSON'da METİN gelir
  createdAt: T0, expiresAt: null, metadata: { toolName: "send_email" }, run: run("run-bbbbbbbb"),
  artifact: { kind: "email", title: "Haftalık özet", body: "Merhaba,\nBu hafta 14 e-posta yanıtlandı.", source: "draft" },
  details: { risk: "high", permissions: ["send_email"], dataTransfer: ["send_email ← girdi alanları: to, subject, body"], reversible: false },
};
const A_OLD = {
  id: "a3", runId: "run-cccccccc", type: "SPEND", status: "PENDING", description: "Eski onay", amountUsd: null,
  createdAt: T0, expiresAt: null, metadata: { toolName: "legacy_tool" }, artifact: null, run: run("run-cccccccc"),
  details: { risk: null, permissions: null, dataTransfer: null, reversible: null },
};
const base3 = { type: "SPEND", status: "PENDING", createdAt: T0, expiresAt: null, artifact: null, run: run("run-x") };
/** Üç tetikleyici AYRI AYRI: yalnız tutar, yalnız yüksek risk, yalnız geri alınamaz. */
const A_AMOUNT_ONLY = { ...base3, id: "t1", runId: "run-x", description: "Yalnız tutar", amountUsd: "0.01", metadata: { toolName: "pay" }, details: { risk: "low", permissions: ["pay"], dataTransfer: ["x"], reversible: true } };
const A_RISK_ONLY = { ...base3, id: "t2", runId: "run-x", description: "Yalnız risk", amountUsd: null, metadata: { toolName: "risky" }, details: { risk: "high", permissions: ["risky"], dataTransfer: ["x"], reversible: true } };
const A_IRREV_ONLY = { ...base3, id: "t3", runId: "run-x", description: "Yalnız geri alınamaz", amountUsd: "0.00", metadata: { toolName: "irrev" }, details: { risk: "low", permissions: ["irrev"], dataTransfer: ["x"], reversible: false } };
const A_ZERO_TEXT = { ...base3, id: "t4", runId: "run-x", description: "Sıfır tutar metni", amountUsd: "0.00", metadata: { toolName: "free" }, details: { risk: "low", permissions: ["free"], dataTransfer: ["x"], reversible: true } };
const A_BAD_AMOUNT = { ...base3, id: "t5", runId: "run-x", description: "Okunamayan tutar", amountUsd: "12,50", metadata: { toolName: "pay" }, details: { risk: "low", permissions: ["pay"], dataTransfer: ["x"], reversible: true } };
const A_NODETAILS = { ...A_OLD, id: "a4", description: "Çok eski onay", details: null, metadata: {} };

type Calls = { method: string; path: string; body: unknown }[];
interface MockOpts { list?: unknown[]; decideStatus?: number; decideDelayMs?: number }

async function mockApi(page: Page, opts: MockOpts = {}): Promise<Calls> {
  const calls: Calls = [];
  let rows = [...(opts.list ?? [A_LOW, A_DANGER, A_OLD])];
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
    const decide = path.match(/^\/approvals\/([^/]+)\/decide$/);
    if (decide && req.method() === "POST") {
      if (opts.decideDelayMs) await new Promise((r) => setTimeout(r, opts.decideDelayMs));
      if (opts.decideStatus && opts.decideStatus >= 400) {
        if (opts.decideStatus === 409) rows = rows.filter((r) => (r as { id: string }).id !== decide[1]); // başkası karara bağlamış: liste yenilenince satır yok
        return json(opts.decideStatus, { error: "no" });
      }
      rows = rows.filter((r) => (r as { id: string }).id !== decide[1]);
      return json(200, { success: true, decision: (body as { decision: string }).decision });
    }
    if (path === "/approvals" || path.startsWith("/approvals?")) return json(200, rows);
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

test.describe("bayrak KAPALI: /approvals eski ekranla birebir", () => {
  test("altın #main-content HTML'i eşit; yeni bileşenler yok", async ({ page }) => {
    await prepare(page, "dark");
    await page.clock.setFixedTime(new Date("2026-11-11T12:00:00.000Z"));
    const calls = await mockApi(page);
    await page.goto(`${UI}/approvals`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Müşteriye e-posta gönder")).toBeVisible();
    await page.waitForTimeout(600);
    const html = normalize(await page.locator("#main-content").evaluate((el) => el.outerHTML));

    expect(await page.getByTestId("approval-center").count()).toBe(0);
    expect(calls.filter((c) => c.method === "GET" && c.path.startsWith("/approvals")).length).toBeGreaterThan(0);

    if (process.env.UX_APPROVALS_UPDATE_GOLDEN === "1") {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, JSON.stringify({ source: "main d9c6c58 (UX-05i öncesi)", list: html }, null, 2) + "\n");
      return;
    }
    expect(existsSync(GOLDEN), "altın dosya yok: önce UX_APPROVALS_UPDATE_GOLDEN=1 ile ESKİ derlemede üret").toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as { list: string };
    expect(html).toBe(golden.list);
  });

  test("bayrak kapalı ve açık sunucuda oturumsuz /approvals aynı davranır (login'e yönlenir)", async ({ page }) => {
    await page.setExtraHTTPHeaders({ "X-Forwarded-Proto": "https" });
    for (const base of [UI, UI_LAB]) {
      const res = await page.goto(`${base}/approvals`);
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
const decides = (calls: Calls) => calls.filter((c) => c.method === "POST" && /^\/approvals\/[^/]+\/decide$/.test(c.path));
const center = (page: Page) => page.getByTestId("approval-center");
const sheet = (page: Page) => page.getByTestId("approval-sheet");
const snap = async (page: Page, file: string) => { await page.waitForTimeout(450); await page.screenshot({ path: file }); };

for (const { vp, size, scheme } of COMBOS) {
  test.describe(`bayrak AÇIK: onay merkezi (${vp}, ${scheme})`, () => {
    test.use({ viewport: size });

    test("liste, düşük risk sheet, tehlikeli ikinci adım, Bilgi yok, boş durum", async ({ page }) => {
      if (SHOTS) mkdirSync(SHOTS, { recursive: true });
      const shot = async (name: string) => { if (SHOTS) await snap(page, join(SHOTS, `${name}-${vp}-${scheme}.png`)); };
      await prepare(page, scheme);
      await page.clock.setFixedTime(new Date("2026-11-11T12:00:00.000Z"));
      await mockApi(page, { list: [A_LOW, A_DANGER, A_OLD] });
      await page.goto(`${UI_LAB}/approvals`);
      await expect(center(page)).toBeVisible();
      await expect(center(page).getByRole("heading", { level: 1, name: "Onay ve güvenlik merkezi" })).toBeVisible();
      await expect(page.getByTestId("approval-list").getByRole("listitem")).toHaveCount(3);
      await expect(page.getByTestId("approval-live")).toContainText("3 onay bekliyor");
      await expect(center(page)).not.toContainText(/hepsini onayla|toplu/i);
      await shot("01-liste");

      // Düşük risk: tek adım, alanlar dolu
      await page.getByTestId("approval-row-a1").click();
      await expect(sheet(page)).toBeVisible();
      await expect(sheet(page)).toHaveAttribute("aria-modal", "true");
      await expect(sheet(page).getByRole("heading", { name: "Slack'e mesaj gönder" })).toBeFocused();
      const fields = page.getByTestId("approval-fields");
      await expect(fields).toContainText("slack.post");
      await expect(fields).toContainText("slack.post:POST");
      await expect(fields).toContainText("Düşük");
      await expect(fields).toContainText("Karşıt eylemle döndürülebilir");
      await expect(page.getByTestId("approval-danger")).toHaveCount(0);
      await expect(page.getByTestId("approval-approve")).toBeEnabled();
      await shot("02-sheet-dusuk-risk");
      await page.keyboard.press("Escape");
      await expect(sheet(page)).toHaveCount(0);
      await expect(page.getByTestId("approval-row-a1")).toBeFocused();

      // Tehlikeli: ikinci adım kilitli
      await page.getByTestId("approval-row-a2").click();
      await expect(fields).toContainText("Geri alınamaz");
      await expect(fields).toContainText("Yüksek");
      await expect(page.getByTestId("approval-danger")).toBeVisible();
      await expect(page.getByTestId("approval-approve")).toBeDisabled();
      await expect(page.getByTestId("approval-reject")).toBeEnabled();
      await shot("03-sheet-tehlikeli-kilitli");
      await page.getByTestId("approval-confirm-input").fill("gönderimi");
      await expect(page.getByTestId("approval-approve")).toBeDisabled();
      await page.getByTestId("approval-confirm-input").fill("  GÖNDERİMİ onaylıyorum ");
      await page.getByTestId("approval-reason").fill("Müşteri onayı alındı");
      await expect(page.getByTestId("approval-approve")).toBeEnabled();
      await shot("04-sheet-tehlikeli-cumle-yazildi");
      await page.keyboard.press("Escape");

      // Bilgi yok (eski onay)
      await page.getByTestId("approval-row-a3").click();
      await expect(fields).toContainText("legacy_tool");
      expect(await fields.getByText("Bilgi yok").count()).toBe(6); // yetki, veri, risk, tutar, geri alma, taslak
      await expect(fields).not.toContainText("Karşıt eylemle");
      await expect(fields).not.toContainText("Geri alınamaz");
      await shot("05-sheet-bilgi-yok");
      await page.keyboard.press("Escape");

      // Boş durum
      const empty = await page.context().newPage();
      await prepare(empty, scheme);
      await mockApi(empty, { list: [] });
      await empty.goto(`${UI_LAB}/approvals`);
      await expect(empty.getByText("Her şey temiz!")).toBeVisible();
      if (SHOTS) await snap(empty, join(SHOTS, `06-bos-${vp}-${scheme}.png`));
      await empty.close();
    });
  });
}

test.describe("bayrak AÇIK: karar akışı ve erişilebilirlik", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("düşük risk tek adım: Onayla decide'ı çağırır, satır gider, odak başlığa döner", async ({ page }) => {
    await prepare(page, "dark");
    const calls = await mockApi(page);
    await page.goto(`${UI_LAB}/approvals`);
    await page.getByTestId("approval-row-a1").click();
    await page.getByTestId("approval-approve").click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.getByTestId("approval-row-a1")).toHaveCount(0);
    const post = calls.find((c) => c.method === "POST" && c.path === "/approvals/a1/decide");
    expect(post?.body).toEqual({ decision: "APPROVED" });
    await expect(center(page).getByRole("heading", { level: 1 })).toBeFocused();
    await expect(page.getByTestId("approval-live")).toContainText("Onaylandı.");
  });

  test("tehlikeli onay: cümle + sebep decide notu olarak gider; toplu çağrı yok", async ({ page }) => {
    await prepare(page, "dark");
    const calls = await mockApi(page);
    await page.goto(`${UI_LAB}/approvals`);
    await page.getByTestId("approval-row-a2").click();
    await page.getByTestId("approval-confirm-input").fill("gönderimi onaylıyorum");
    await page.getByTestId("approval-reason").fill("Müşteri onayı alındı");
    await page.getByTestId("approval-approve").click();
    await expect(sheet(page)).toHaveCount(0);
    const posts = decides(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ path: "/approvals/a2/decide", body: { decision: "APPROVED", note: "Müşteri onayı alındı" } });
  });

  test("tehlikeli onayı REDDETMEK ikinci adım istemez", async ({ page }) => {
    await prepare(page, "dark");
    const calls = await mockApi(page);
    await page.goto(`${UI_LAB}/approvals`);
    await page.getByTestId("approval-row-a2").click();
    await page.getByTestId("approval-reject").click();
    await expect(sheet(page)).toHaveCount(0);
    expect(decides(calls)[0]?.body).toEqual({ decision: "REJECTED" });
    await expect(page.getByTestId("approval-live")).toContainText("Reddedildi.");
  });

  test("Enter cümle alanında yalnız cümle eşleşince onaylar; IME birleştirmesi sırasında onaylamaz", async ({ page }) => {
    await prepare(page, "dark");
    const calls = await mockApi(page);
    await page.goto(`${UI_LAB}/approvals`);
    await page.getByTestId("approval-row-a2").click();
    const input = page.getByTestId("approval-confirm-input");
    await input.fill("yanlış");
    await input.press("Enter");
    expect(decides(calls)).toHaveLength(0);
    await input.fill("Gönderimi onaylıyorum");
    await input.evaluate((el) => el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await input.press("Enter");
    expect(decides(calls)).toHaveLength(0);
    await input.evaluate((el) => el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    await input.press("Enter");
    await expect.poll(() => decides(calls).length).toBe(1);
  });

  test("odak tuzağı: Tab sheet içinde döner; Esc kapatır ve odak satıra döner", async ({ page }) => {
    await prepare(page, "dark");
    await mockApi(page);
    await page.goto(`${UI_LAB}/approvals`);
    const row = page.getByTestId("approval-row-a3");
    await row.click();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest("[data-testid=approval-sheet]"))).toBe(true);
    }
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("[data-testid=approval-sheet]"))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toHaveCount(0);
    await expect(row).toBeFocused();
  });

  test("decide başarısız olursa sheet açık kalır ve hata duyurulur; satır silinmez", async ({ page }) => {
    await prepare(page, "dark");
    await mockApi(page, { decideStatus: 500 });
    await page.goto(`${UI_LAB}/approvals`);
    await page.getByTestId("approval-row-a1").click();
    await page.getByTestId("approval-approve").click();
    await expect(sheet(page).getByRole("alert")).toBeVisible();
    await expect(page.getByTestId("approval-row-a1")).toHaveCount(1);
  });

  test("details'ı hiç olmayan onay (null) Bilgi yok yazar, uydurma alan çıkmaz", async ({ page }) => {
    await prepare(page, "dark");
    await mockApi(page, { list: [A_NODETAILS] });
    await page.goto(`${UI_LAB}/approvals`);
    await page.getByTestId("approval-row-a4").click();
    await expect(page.getByTestId("approval-danger")).toHaveCount(0);
    expect(await page.getByTestId("approval-fields").getByText("Bilgi yok").count()).toBe(7);
  });

  test("RTL (ar) ve hareket azaltma: sheet açılır, yön rtl, animasyon yok", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await prepare(page, "dark");
    await page.addInitScript(() => { try { localStorage.setItem("locale", "ar"); } catch { /* */ } document.cookie = "NEXT_LOCALE=ar; path=/"; });
    await mockApi(page);
    await page.goto(`${UI_LAB}/approvals`);
    await expect(center(page)).toBeVisible();
    await page.getByTestId("approval-row-a1").click();
    await expect(sheet(page)).toBeVisible();
    expect(await sheet(page).evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  });

  test("üç tetikleyici ayrı ayrı ikinci adımı kilitler; metin tutar '0.00' tek başına tehlikeli değildir", async ({ page }) => {
    await prepare(page, "dark");
    await mockApi(page, { list: [A_AMOUNT_ONLY, A_RISK_ONLY, A_IRREV_ONLY, A_ZERO_TEXT] });
    await page.goto(`${UI_LAB}/approvals`);
    for (const id of ["t1", "t2", "t3"]) {
      await page.getByTestId(`approval-row-${id}`).click();
      await expect(page.getByTestId("approval-danger")).toBeVisible();
      await expect(page.getByTestId("approval-approve")).toBeDisabled();
      await page.keyboard.press("Escape");
    }
    await page.getByTestId("approval-row-t1").click();
    await expect(page.getByTestId("approval-fields")).toContainText("$0,01"); // metin tutar "Bilgi yok" DEĞİL, gösterilir
    await page.keyboard.press("Escape");
    await page.getByTestId("approval-row-t4").click(); // "0.00": tutar yok sayılır, başka tetikleyici de yok
    await expect(page.getByTestId("approval-danger")).toHaveCount(0);
    await expect(page.getByTestId("approval-approve")).toBeEnabled();
  });

  test("okunamayan tutar ('12,50') fail-closed: kilit çıkar, ham değer gösterilmez", async ({ page }) => {
    await prepare(page, "dark");
    await mockApi(page, { list: [A_BAD_AMOUNT] });
    await page.goto(`${UI_LAB}/approvals`);
    await page.getByTestId("approval-row-t5").click();
    await expect(page.getByTestId("approval-danger")).toBeVisible();
    await expect(page.getByTestId("approval-approve")).toBeDisabled();
    await expect(page.getByTestId("approval-fields")).not.toContainText("12,50");
  });

  test("metin tutar ('12.50') listede ve sheet'te görünür, tehlikeli kilit çıkar", async ({ page }) => {
    await prepare(page, "dark");
    await mockApi(page, { list: [A_DANGER] });
    await page.goto(`${UI_LAB}/approvals`);
    await expect(page.getByTestId("approval-row-a2")).toContainText("$12,50");
    await page.getByTestId("approval-row-a2").click();
    await expect(page.getByTestId("approval-fields")).toContainText("$12,50");
    await expect(page.getByTestId("approval-approve")).toBeDisabled();
  });

  test("cümle yazınca Onayla açılır; sheet yeniden açılınca cümle ve sebep sıfırlanır", async ({ page }) => {
    await prepare(page, "dark");
    await mockApi(page);
    await page.goto(`${UI_LAB}/approvals`);
    await page.getByTestId("approval-row-a2").click();
    await page.getByTestId("approval-confirm-input").fill("gönderimi onaylıyorum");
    await page.getByTestId("approval-reason").fill("sebep");
    await expect(page.getByTestId("approval-approve")).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toHaveCount(0);
    await page.getByTestId("approval-row-a2").click();
    await expect(page.getByTestId("approval-confirm-input")).toHaveValue("");
    await expect(page.getByTestId("approval-reason")).toHaveValue("");
    await expect(page.getByTestId("approval-approve")).toBeDisabled();
  });

  test("409 (zaten karara bağlanmış): dürüst mesaj, liste yeniden yüklenir, bayat satır kalmaz", async ({ page }) => {
    await prepare(page, "dark");
    const calls = await mockApi(page, { decideStatus: 409 });
    await page.goto(`${UI_LAB}/approvals`);
    const lists = () => calls.filter((c) => c.method === "GET" && c.path.startsWith("/approvals")).length;
    const before = lists();
    await page.getByTestId("approval-row-a1").click();
    await page.getByTestId("approval-approve").click();
    await expect(page.getByRole("alert").filter({ hasText: "zaten karara bağlanmış" })).toBeVisible();
    await expect.poll(lists).toBeGreaterThan(before);
    await expect(page.getByTestId("approval-row-a1")).toHaveCount(0);
  });

  test("karar sürerken başka onay açılırsa önceki onayın sonucu yeni sheet'i kapatmaz ve devre dışılığı taşımaz", async ({ page }) => {
    await prepare(page, "dark");
    const calls = await mockApi(page, { decideDelayMs: 1200 });
    await page.goto(`${UI_LAB}/approvals`);
    await page.getByTestId("approval-row-a1").click();
    await page.getByTestId("approval-approve").click();
    await expect(page.getByTestId("approval-approve")).toBeDisabled(); // a1 sürüyor
    await page.keyboard.press("Escape");
    await page.getByTestId("approval-row-a3").click();
    await expect(page.getByTestId("approval-approve")).toBeEnabled(); // a3'ün sheet'i a1'in meşgul durumunu taşımaz
    await expect.poll(() => decides(calls).length).toBe(1);
    await expect(page.getByTestId("approval-row-a1")).toHaveCount(0, { timeout: 5000 }); // a1 işlendi
    await expect(sheet(page)).toBeVisible(); // a3 sheet'i açık kaldı
    await expect(sheet(page).getByRole("heading", { name: "Eski onay" })).toBeVisible();
  });

  test("Klasik görünüm bağlantısı bayrak açıkken eski sayfayı verir", async ({ page }) => {
    await prepare(page, "dark");
    await mockApi(page);
    await page.goto(`${UI_LAB}/approvals`);
    await center(page).getByRole("link", { name: "Klasik onay görünümü" }).click();
    await page.waitForURL(/view=classic/);
    await expect(page.getByText("Müşteriye e-posta gönder")).toBeVisible();
    expect(await page.getByTestId("approval-center").count()).toBe(0);
  });
});

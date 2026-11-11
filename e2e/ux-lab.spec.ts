import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { UI, UI_LAB } from "./ports";

/**
 * BRA-UX-04 — etkileşimli prototip (`/lab/ux`, ADR-0004).
 *
 * İki sunucu AYNI derlemeyi sunar (playwright.config.ts): `UI` bayrak KAPALI, `UI_LAB` bayrak AÇIK
 * (`NEXT_PUBLIC_UX_LAB` istek anında okunur). Kabul: (1) bayrak kapalıyken mevcut ekranlarda fark yok,
 * (2) açıkken 9 yolculuk ÖRNEK kipte (oturum/API gerekmez) uçtan uca çalışır.
 *
 * `UX_LAB_SCREEN_DIR` verilirse her yolculuk ekran görüntüsü kaydeder (masaüstü 1440×900 + mobil 390×844 × açık/koyu);
 * verilmezse yalnız bir bileşim (masaüstü/koyu) koşar.
 */
const SHOTS = process.env.UX_LAB_SCREEN_DIR;

async function prepare(page: Page, scheme: "light" | "dark") {
  await page.setExtraHTTPHeaders({ "X-Forwarded-Proto": "https" });
  await page.addInitScript((s) => {
    try { localStorage.setItem("braavo-theme", s); localStorage.setItem("cookie_consent", "essential-only"); } catch { /* storage kapalı */ }
  }, scheme);
}

test.describe("bayrak KAPALI: mevcut ekranlarda fark yok", () => {
  test("/lab/ux 404 döner ve prototip işaretini taşımaz", async ({ page }) => {
    await prepare(page, "dark");
    const res = await page.goto(`${UI}/lab/ux`);
    expect(res?.status()).toBe(404);
    await expect(page.getByText("Prototip (BRA-UX-04)")).toHaveCount(0);
    expect((await page.goto(`${UI}/lab/ux?mode=sample`))?.status()).toBe(404);
  });

  for (const path of ["/", "/start", "/inbox", "/approvals", "/runs", "/login", "/pricing", "/dashboard"]) {
    test(`${path}: bayrak kapalı ve açık sunucuda aynı durum kodu ve başlık`, async ({ page }) => {
      await prepare(page, "dark");
      const off = await page.goto(`${UI}${path}`);
      await page.waitForLoadState("networkidle");
      const offTitle = await page.title();
      const offUrl = new URL(page.url()).pathname;
      const on = await page.goto(`${UI_LAB}${path}`);
      await page.waitForLoadState("networkidle");
      expect(off?.status(), path).toBeLessThan(500);
      expect(on?.status()).toBe(off?.status());
      expect(await page.title()).toBe(offTitle);
      // Oturumsuz yönlendirme davranışı da aynı (örn. /inbox → /login).
      expect(new URL(page.url()).pathname).toBe(offUrl);
      await expect(page.getByText("Prototip (BRA-UX-04)")).toHaveCount(0);
    });
  }
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
  test.describe(`bayrak AÇIK: prototip yolculukları (${vp}, ${scheme})`, () => {
    test.use({ viewport: size });

    test("9 yolculuk örnek kipte uçtan uca", async ({ page }) => {
      if (SHOTS) mkdirSync(SHOTS, { recursive: true });
      const shot = async (name: string) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}-${vp}-${scheme}.png`), fullPage: false }); };
      const nav = (label: string) => page.getByRole("navigation", { name: "Prototip gezinmesi" }).getByRole("button", { name: new RegExp(`^${label}`) });
      const intent = page.getByLabel("Ne yapmak istiyorsun?");

      await prepare(page, scheme);
      const res = await page.goto(`${UI_LAB}/lab/ux?mode=sample`);
      expect(res?.status()).toBe(200);
      await expect(page.getByTestId("uxl-mode")).toHaveAttribute("data-mode", "sample");
      await expect(page.getByTestId("uxl-mode")).toHaveText("ÖRNEK VERİ");
      await expect(page.getByTestId("uxl-expected")).toContainText("2 onay · 1 takıldı");
      await shot("01-baslangic");

      // T1 — normal sohbet başlat: plana düşmez, iş oluşmaz.
      await intent.fill("Merhaba, nasılsın?");
      await expect(page.getByRole("radio", { name: "Sohbet" })).toHaveAttribute("aria-checked", "true");
      await page.getByRole("button", { name: "Sohbet başlat" }).click();
      await expect(page.getByTestId("uxl-chat")).toContainText("İş kaydı oluşturulmadı");
      await expect(page.getByTestId("uxl-plan-card")).toHaveCount(0);
      await shot("02-sohbet");

      // T2 — iş tarif et (onaysız): plan kartı → çalıştır → İşler.
      await intent.fill("Müşteri e-postalarını özetle ve taslak olarak kaydet");
      await expect(page.getByRole("radio", { name: "İş" })).toHaveAttribute("aria-checked", "true");
      await page.getByRole("button", { name: "Planla" }).click();
      const card = page.getByTestId("uxl-plan-card");
      await expect(card).toHaveAttribute("data-risk", "low");
      await expect(card).toContainText("Tahmini maliyet");
      await shot("03-plan-karti");
      await card.getByRole("button", { name: /Çalıştır/ }).click();
      await expect(page.getByText("İş başlatıldı")).toBeVisible();
      await expect(nav("İşler")).toHaveAttribute("aria-current", "page");
      await expect(page.getByTestId("uxl-drawer")).toBeVisible();
      await page.getByRole("button", { name: "Çekmeceyi kapat" }).click();
      await expect(page.getByTestId("uxl-counts")).toContainText("Çalışıyor 3");

      // T2b — onay adımlı iş: kapı kapalıyken 422 açıkça gösterilir, düğme gizlenmez ama engelli.
      await nav("Başla").click();
      await intent.fill("Haftalık özeti Slack'e gönder ve kanala yaz");
      await page.getByRole("button", { name: "Planla" }).click();
      await expect(page.getByTestId("uxl-plan-card")).toHaveAttribute("data-risk", "high");
      await page.getByTestId("uxl-plan-card").getByRole("button", { name: /Çalıştır/ }).click();
      await expect(page.getByRole("alert").filter({ hasText: "otomatik başlatılamaz" })).toBeVisible();
      await expect(page.getByTestId("uxl-plan-card").getByRole("button", { name: /Çalıştır/ })).toBeDisabled();
      await shot("04-onayli-is-kapi-kapali");

      // T5 — ajan oluştur: çıkarılan araç uyarısı görünür.
      await intent.fill("Her sabah satış e-postalarını özetleyen bir ajan oluştur");
      await expect(page.getByRole("radio", { name: "Ajan" })).toHaveAttribute("aria-checked", "true");
      await page.getByRole("button", { name: "Ajanı oluştur" }).click();
      await expect(page.getByTestId("uxl-dropped")).toContainText("hubspot");
      await shot("05-ajan");

      // T3 — devam eden işi bul.
      await nav("İşler").click();
      await expect(page.getByTestId("uxl-counts")).toContainText("Onay 2");
      await expect(page.locator('[data-testid="uxl-run"][data-bucket="working"]')).toHaveCount(3);
      await shot("06-isler");

      // T4 — onay anlama: eksik alan "bilgi yok"; tehlikeli olan ikinci adım ister.
      await page.getByTestId("uxl-approval").first().getByRole("button", { name: "İncele" }).click();
      const sheet = page.getByTestId("uxl-sheet");
      await expect(sheet).toContainText("slack.post");
      await expect(sheet.locator('[data-fact="reversible"]')).toContainText("bilgi yok");
      await shot("07-onay");
      await page.getByRole("button", { name: "Kapat", exact: true }).click();
      await page.getByTestId("uxl-approval").nth(1).getByRole("button", { name: "İncele" }).click();
      await expect(sheet).toHaveAttribute("data-dangerous", "true");
      await sheet.getByRole("button", { name: "Onayla…" }).click();
      await expect(sheet.getByRole("button", { name: "Onayla", exact: true })).toBeDisabled();
      await shot("08-onay-ikinci-adim");
      await sheet.getByLabel(/yaz$/).fill("Onaylıyorum");
      await sheet.getByLabel(/Sebep/).fill("Bütçe tamam");
      await sheet.getByRole("button", { name: "Onayla", exact: true }).click();
      await expect(page.getByText("Onaylandı.")).toBeVisible();
      await expect(page.getByTestId("uxl-counts")).toContainText("Onay 1");

      // T7 — Kaputu Aç: ≤2 tık, adım + araç çağrısı + maliyet; Sade/Tam aynı değerler.
      await page.getByRole("button", { name: "Rapor taslağı işini aç" }).click();
      await page.getByRole("tab", { name: "Kaput" }).click();
      const kaput = page.getByTestId("uxl-kaput");
      await expect(kaput).toContainText("Adımlar (3)");
      await expect(kaput).toContainText("Maliyet: $0,42");
      await expect(kaput).toContainText("Model, yönlendirme kararı ve yetki dökümü");
      await page.getByLabel("Ayrıntı düzeyi").selectOption("full");
      await expect(kaput).toContainText("gmail.list");
      await expect(kaput).toContainText("Adımlar (3)");
      await shot("09-kaput");
      await page.getByRole("button", { name: "Çekmeceyi kapat" }).click();

      // T6 — şirket durumu: tek satır özet (onaylanan takılı iş 'çalışıyor'a geçti, yeni iş eklendi).
      await nav("Şirket").click();
      await expect(page.getByTestId("uxl-company-line")).toHaveText("1 onay · 0 takıldı");
      await expect(page.getByTestId("uxl-company-summary")).toContainText("Çalışan 4");
      await shot("10-sirket");

      // T8 — model maliyeti ve erişim: veri yoksa "veri yok".
      await nav("Yönet").click();
      await page.getByRole("button", { name: /Modeller ve bağlantılar/ }).click();
      await expect(page.getByTestId("uxl-models")).toContainText("veri yok");
      await shot("11-modeller");
    });
  });
}

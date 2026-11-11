import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { UI, UI_LAB } from "./ports";

/**
 * BRA-UX-05c — İşler omurgası: `/inbox` (bayrak `NEXT_PUBLIC_UX_JOBS`, varsayılan KAPALI).
 *
 * İki sunucu AYNI derlemeyi sunar (playwright.config.ts): `UI` bayrak KAPALI, `UI_LAB` bayrak AÇIK (istek anında okunur).
 * API tarayıcıda `page.route` ile taklit edilir (Postgres/API gerekmez): istekler ve gövdeleri doğrulanır.
 *
 *  1. EŞİTLİK: bayrak kapalıyken `/inbox` BU BİLETTEN ÖNCEKİ ekrandır. `e2e/golden/inbox-legacy.json` UX-05c öncesi derlemeden
 *     (main `b5b32c4`) alınmış normalize `#main-content` HTML'idir; kapalı sunucu ile birebir eşit olmalı.
 *     Altın dosyayı yenilemek bilinçli bir işlemdir: `UX_JOBS_UPDATE_GOLDEN=1` (yalnız eski ekranı değiştiren bilet yapar).
 *  2. Bayrak açıkken: 4 kova, satır alanları, çekmece (Özet/Çıktı/Kaput), eylem, onay kovasında risk.
 *
 * `UX_JOBS_SCREEN_DIR` verilirse ekran görüntüleri (1440×900 + 390×844 × açık/koyu) kaydedilir.
 */
const SHOTS = process.env.UX_JOBS_SCREEN_DIR;
const GOLDEN = join(__dirname, "golden", "inbox-legacy.json");
/** `NEXT_PUBLIC_API_URL` derleme anında gömülür (yerelde varsayılan localhost:8080, CI'da operator adresi): ikisi de yakalanır. */
const isApi = (url: URL) => url.pathname.startsWith("/api/v1/") && (url.hostname === "api.operator.example" || url.host === "localhost:8080");

const T0 = "2026-11-11T09:00:00.000Z";
const COMPANY = { id: "c1", name: "Atölye" };
const run = (id: string, title: string, over: Record<string, unknown>) => ({
  id, pipelineId: `p-${id}`, status: "RUNNING", state: "RUNNING", resultStatus: null, costUsd: 0.42, createdAt: T0, updatedAt: T0, bucket: "working",
  pipeline: { id: `p-${id}`, name: title, company: COMPANY }, ...over,
});
const RUNS: Record<string, unknown[]> = {
  working: [run("r1", "Rapor taslağı", {}), run("r2", "Haftalık e-posta özeti", { costUsd: 0.18 })],
  needs_approval: [run("r3", "Slack'e haftalık özet gönder", { status: "WAITING_APPROVAL", state: "NEEDS_APPROVAL", bucket: "needs_approval", costUsd: 0.05 })],
  stuck: [run("r4", "Müşteri veri aktarımı", { bucket: "stuck", costUsd: 1.2, heartbeatAt: "2026-11-11T08:00:00.000Z" })],
  done: [run("r5", "Fatura özeti", { status: "COMPLETED", state: "COMPLETED", resultStatus: "VERIFIED", bucket: "done", costUsd: 0.31 })],
};
const GROUPS = [{
  runId: "r3", runTitle: "Slack'e haftalık özet gönder",
  approvals: [{
    id: "a1", runId: "r3", type: "TOOL", status: "PENDING", description: "#genel kanalına 1 mesaj gönder", amountUsd: null, createdAt: T0,
    metadata: { toolName: "slack.post" },
    details: { risk: "medium", permissions: ["slack:write"], dataTransfer: [], reversible: null },
    artifact: { kind: "message", title: "#genel", body: "Bu hafta 14 e-posta özetlendi." },
  }],
}];
const KAPUT = {
  id: "r1", costUsd: 0.42,
  steps: [
    { id: "s1", stepIndex: 0, name: "Kaynakları topla", agentRole: "researcher", status: "COMPLETED", costUsd: 0.1, toolCalls: [{ id: "t1", toolName: "read", status: "COMPLETED", durationMs: 120 }] },
    { id: "s2", stepIndex: 1, name: "Taslağı yaz", agentRole: "writer", status: "RUNNING", costUsd: 0.32, toolCalls: [] },
  ],
};

type Calls = { method: string; path: string; body: unknown }[];
interface MockOpts { runsFail?: boolean; actionStatus?: number; kaputFail?: boolean }

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
    if (path === "/runs" && req.method() === "GET") {
      if (opts.runsFail) return json(500, { error: "boom" });
      return json(200, { runs: RUNS[url.searchParams.get("bucket") ?? "working"] ?? [], nextCursor: null });
    }
    if (path === "/approvals" && req.method() === "GET") return json(200, { groups: GROUPS, nextCursor: null });
    if (/^\/runs\/[^/]+\/(pause|resume|stop|retry)$/.test(path)) return json(opts.actionStatus ?? 200, opts.actionStatus && opts.actionStatus >= 400 ? { error: "no" } : {});
    if (/^\/runs\/[^/]+\/handoffs$/.test(path)) return json(200, { handoffs: [{ id: "h1" }] });
    if (/^\/runs\/[^/]+\/receipt$/.test(path)) return json(404, { error: "none" });
    if (/^\/runs\/[^/]+$/.test(path) && req.method() === "GET") return opts.kaputFail ? json(500, { error: "boom" }) : json(200, KAPUT);
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
const snap = async (page: Page, file: string) => { await page.waitForTimeout(450); await page.screenshot({ path: file }); };

test.use({ locale: "tr-TR", timezoneId: "UTC" });

test.describe("bayrak KAPALI: /inbox eski ekranla birebir", () => {
  test("altın #main-content HTML'i (çalışıyor ve onay kovası) eşit; yeni bileşenler yok", async ({ page }) => {
    await prepare(page, "dark");
    const calls = await mockApi(page);
    await page.goto(`${UI}/inbox`);
    const main = page.locator("#main-content");
    await expect(page.getByText("Rapor taslağı")).toBeVisible();
    await expect(page.getByText("Haftalık e-posta özeti")).toBeVisible();
    const working = normalize(await main.evaluate((el) => el.outerHTML));

    await page.getByRole("tab", { name: "Onay bekliyor" }).click();
    await expect(page.getByText("#genel kanalına 1 mesaj gönder")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Bekleyen onaylar" })).toBeVisible();
    const needsApproval = normalize(await main.evaluate((el) => el.outerHTML));

    expect(await page.getByTestId("jobs-inbox").count()).toBe(0);
    expect(calls.filter((c) => c.path.startsWith("/runs?bucket=working"))).toHaveLength(1);

    if (process.env.UX_JOBS_UPDATE_GOLDEN === "1") {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, JSON.stringify({ source: "main b5b32c4 (UX-05c öncesi)", working, needsApproval }, null, 2) + "\n");
      return;
    }
    expect(existsSync(GOLDEN), "altın dosya yok: önce UX_JOBS_UPDATE_GOLDEN=1 ile ESKİ derlemede üret").toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as { working: string; needsApproval: string };
    expect(working).toBe(golden.working);
    expect(needsApproval).toBe(golden.needsApproval);
  });

  test("bayrak kapalı ve açık sunucuda oturumsuz /inbox aynı davranır (login'e yönlenir)", async ({ page }) => {
    await page.setExtraHTTPHeaders({ "X-Forwarded-Proto": "https" });
    for (const base of [UI, UI_LAB]) {
      const res = await page.goto(`${base}/inbox`);
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
const jobs = (page: Page) => page.getByTestId("jobs-inbox");
const drawer = (page: Page) => page.getByTestId("job-drawer");

for (const { vp, size, scheme } of COMBOS) {
  test.describe(`bayrak AÇIK: İşler (${vp}, ${scheme})`, () => {
    test.use({ viewport: size });

    test("4 kova, satır alanları, çekmece Özet → Çıktı → Kaput, Duraklat", async ({ page }) => {
      if (SHOTS) mkdirSync(SHOTS, { recursive: true });
      const shot = async (name: string) => { if (SHOTS) await snap(page, join(SHOTS, `${name}-${vp}-${scheme}.png`)); };
      await prepare(page, scheme);
      const calls = await mockApi(page);
      await page.goto(`${UI_LAB}/inbox`);
      await expect(jobs(page)).toBeVisible();
      await expect(page.getByRole("heading", { name: "İşler", level: 1 })).toBeVisible();
      await expect(page.getByRole("tab")).toHaveCount(4);

      const rows = page.getByTestId("job-row");
      await expect(rows).toHaveCount(2);
      await expect(rows.first()).toContainText("Rapor taslağı");
      await expect(rows.first()).toContainText("Atölye");
      await expect(rows.first()).toContainText("çalışıyor");
      await expect(rows.first()).toContainText("0,42");
      await shot("01-calisiyor");

      await rows.first().getByRole("button", { name: /Rapor taslağı/ }).click();
      await expect(drawer(page)).toBeVisible();
      await expect(drawer(page).getByRole("heading", { name: "Rapor taslağı" })).toBeFocused();
      await expect(drawer(page)).toContainText("Atölye");
      await shot("02-cekmece-ozet");

      await drawer(page).getByRole("tab", { name: "Kaput" }).click();
      await expect(drawer(page).getByTestId("job-kaput")).toContainText("Adımlar (2)");
      await expect(drawer(page).getByTestId("job-kaput")).toContainText("Araç çağrısı: 1");
      await expect(drawer(page).getByTestId("job-kaput")).toContainText("El değiştirme: 1");
      await expect(drawer(page).getByTestId("job-kaput")).toContainText("Kaynakları topla");
      expect(calls.some((c) => c.path === "/runs/r1" && c.method === "GET")).toBe(true);
      expect(calls.some((c) => c.path === "/runs/r1/handoffs")).toBe(true);
      await shot("03-cekmece-kaput");

      await drawer(page).getByLabel("Ayrıntı").selectOption("full");
      await expect(drawer(page).getByTestId("job-kaput")).toContainText("read");
      await shot("04-cekmece-kaput-tam");

      await drawer(page).getByRole("tab", { name: "Çıktı" }).click();
      await expect(drawer(page).getByRole("tabpanel")).toBeVisible();

      await page.keyboard.press("Escape");
      await expect(drawer(page)).toHaveCount(0);
      await expect(rows.first().getByRole("button", { name: /Rapor taslağı/ })).toBeFocused(); // odak satıra döner

      await rows.first().getByRole("button", { name: /Rapor taslağı/ }).click();
      await drawer(page).getByRole("button", { name: "Duraklat" }).click();
      await expect.poll(() => calls.some((c) => c.method === "POST" && c.path === "/runs/r1/pause")).toBe(true);
      expect(calls.find((c) => c.path === "/runs/r1/pause")?.body).toEqual({});
      await expect(drawer(page)).toHaveCount(0); // iş kova değiştirir: çekmece bayat eylem sunmaz
      await expect(page.getByRole("status").filter({ hasText: "Eylem gönderildi" })).toBeVisible();
    });

    test("onay bekliyor kovası: risk alanı + karar (/approvals/:id/decide); takıldı notu; bitti doğrulama", async ({ page }) => {
      if (SHOTS) mkdirSync(SHOTS, { recursive: true });
      const shot = async (name: string) => { if (SHOTS) await snap(page, join(SHOTS, `${name}-${vp}-${scheme}.png`)); };
      await prepare(page, scheme);
      const calls = await mockApi(page);
      await page.goto(`${UI_LAB}/inbox`);
      await page.getByRole("tab", { name: "Onay bekliyor" }).click();
      await expect(page.getByTestId("job-risk")).toContainText("Risk: orta");
      await expect(page.getByText("#genel kanalına 1 mesaj gönder")).toBeVisible();
      await shot("05-onay-bekliyor");
      await page.getByRole("button", { name: "Onayla" }).click();
      await expect.poll(() => calls.some((c) => c.method === "POST" && c.path === "/approvals/a1/decide")).toBe(true);

      await page.getByRole("tab", { name: "Takıldı" }).click();
      await expect(page.getByTestId("job-row")).toContainText("Müşteri veri aktarımı");
      await expect(page.getByText("Kalp atışı izleme kapalıyken bazı takılmalar henüz görünmüyor.")).toBeVisible();
      await shot("06-takildi");

      await page.getByRole("tab", { name: "Bitti" }).click();
      await expect(page.getByTestId("job-row")).toContainText("✔ Doğrulandı");
      await shot("07-bitti");
    });

    test("liste hatası dürüstçe gösterilir (boş sanılmaz) ve yeniden denenir; Kaput hatası çekmecede", async ({ page }) => {
      await prepare(page, scheme);
      await mockApi(page, { runsFail: true });
      await page.goto(`${UI_LAB}/inbox`);
      await expect(page.getByRole("alert").filter({ hasText: "İşler yüklenemedi" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Yeniden dene" })).toBeVisible();

      const page2 = await page.context().newPage();
      await prepare(page2, scheme);
      await mockApi(page2, { kaputFail: true });
      await page2.goto(`${UI_LAB}/inbox`);
      await page2.getByTestId("job-row").first().getByRole("button", { name: /Rapor taslağı/ }).click();
      await page2.getByRole("tab", { name: "Kaput" }).click();
      await expect(page2.getByRole("alert").filter({ hasText: "Kaput okunamadı" })).toBeVisible();
    });
  });
}

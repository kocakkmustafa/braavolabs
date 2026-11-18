import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { UI, UI_LAB } from "./ports";

/**
 * BRA-UX-05f — Şirket durumu: `/companies/[id]/status` (bayrak `NEXT_PUBLIC_UX_COMPANY`, varsayılan KAPALI).
 * İki sunucu AYNI derlemeyi sunar: `UI` bayrak KAPALI → rota 404 (yeni rota; `/companies/[id]` değişmez), `UI_LAB` bayrak AÇIK.
 * API tarayıcıda `page.route` ile taklit edilir. `UX_COMPANY_SCREEN_DIR` verilirse ekranlar kaydedilir.
 */
const SHOTS = process.env.UX_COMPANY_SCREEN_DIR;
const isApi = (url: URL) => url.pathname.startsWith("/api/v1/") && (url.hostname === "api.operator.example" || url.host === "localhost:8080");

const T = "2026-11-13T09:00:00.000Z";
const run = (id: string, companyId: string, costUsd: unknown, bucket: string) => ({
  id, pipelineId: "p1", status: "RUNNING", state: null, resultStatus: null, trigger: null, costUsd, startedAt: T, completedAt: null, heartbeatAt: null,
  createdAt: T, updatedAt: T, bucket, pipeline: { id: "p1", name: "Bülten", company: { id: companyId, name: companyId } },
});
const COMPANY = { id: "c1", name: "Atölye", agents: [{ id: "a1", name: "Satış Özetçisi", role: "sales_agent" }, { id: "a2", name: "Yazar", role: "" }], pipelines: [] };
const BUCKETS: Record<string, { runs: unknown[]; nextCursor: string | null }> = {
  working: { runs: [run("r1", "c1", "1.500000", "working"), run("r2", "c1", "0.250000", "working"), run("r3", "c2", "99.000000", "working")], nextCursor: null },
  stuck: { runs: [], nextCursor: null },
  needs_approval: { runs: [run("r4", "c1", null, "needs_approval")], nextCursor: null },
  done: { runs: [run("r5", "c1", "1.250000", "done")], nextCursor: null },
};

type Calls = { method: string; path: string }[];
interface MockOpts { company?: { status: number; body?: unknown }; buckets?: Record<string, { status: number; body?: unknown }> }

async function mockApi(page: Page, opts: MockOpts = {}): Promise<Calls> {
  const calls: Calls = [];
  await page.route(isApi, async (route: Route) => {
    const req = route.request();
    const origin = req.headers().origin ?? UI;
    const cors = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api\/v1/, "");
    calls.push({ method: req.method(), path: path + url.search });
    const json = (status: number, data: unknown) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(data) });
    if (path === "/companies/c1") return opts.company ? json(opts.company.status, opts.company.body ?? { error: "x" }) : json(200, COMPANY);
    if (path === "/runs") {
      // BRA-P0-11a: sunucu şirkete süzer ve kova toplamlarını `counts` ile verir.
      const b = url.searchParams.get("bucket") ?? "";
      const cid = url.searchParams.get("companyId") ?? "";
      const mine = (k: string) => (BUCKETS[k]?.runs ?? []).filter((r) => (r as any).pipeline.company.id === cid);
      const counts = Object.fromEntries(Object.keys(BUCKETS).map((k) => [k, mine(k).length]));
      const o = opts.buckets?.[b];
      return o ? json(o.status, o.body ?? { error: "x" }) : json(200, { runs: mine(b), nextCursor: BUCKETS[b]?.nextCursor ?? null, counts });
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

test.describe("bayrak KAPALI: /companies/[id]/status yok (404), mevcut şirket sayfası değişmez", () => {
  test("rota 404 verir ve yeni bileşen yok", async ({ page }) => {
    await prepare(page, "dark");
    await mockApi(page);
    const res = await page.goto(`${UI}/companies/c1/status`);
    expect(res?.status()).toBe(404);
    expect(await page.getByTestId("company-status").count()).toBe(0);
  });
  test("/companies/c1 bayrak kapalıyken de açılır", async ({ page }) => {
    await prepare(page, "dark");
    await mockApi(page);
    const res = await page.goto(`${UI}/companies/c1`);
    expect(res?.status()).toBeLessThan(400);
    expect(await page.getByTestId("company-status").count()).toBe(0);
  });
  test("oturumsuz erişimde açık sunucu login'e yönlenir", async ({ page }) => {
    await page.setExtraHTTPHeaders({ "X-Forwarded-Proto": "https" });
    const res = await page.goto(`${UI_LAB}/companies/c1/status`);
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
  test.describe(`bayrak AÇIK: şirket durumu (${vp}, ${scheme})`, () => {
    test.use({ viewport: size });

    test("tek satır özet (şirket süzgeci), ajanlar, salt-okur, taşma yok", async ({ page }) => {
      if (SHOTS) mkdirSync(SHOTS, { recursive: true });
      await prepare(page, scheme);
      const calls = await mockApi(page);
      await page.goto(`${UI_LAB}/companies/c1/status`);
      const root = page.getByTestId("company-status");
      await expect(root.getByRole("heading", { level: 1, name: "Atölye" })).toBeVisible();
      const line = page.getByTestId("company-summary-line");
      // c2'nin işi (r3, 99$) sayılmaz: çalışan 2, takılan 0, onay bekleyen 1, biten 1; maliyet 1,5+0,25+1,25 = 3.
      await expect(line).toContainText("Çalışan 2 · Takılan 0 · Onay bekleyen 1 · Biten 1 · Maliyet");
      await expect(line).toContainText(/3[.,]0/);
      await expect(line).not.toContainText("99");
      await expect(page.getByTestId("company-summary-note")).toContainText("1 işin maliyeti okunamadı");
      await expect(page.getByTestId("company-agent-a1")).toContainText("Satış Özetçisi");
      await expect(page.getByTestId("company-agent-a1")).toContainText("sales_agent");
      await expect(page.getByTestId("company-agent-a2")).toContainText("Rol: Bilinmiyor");
      await expect(page.getByTestId("company-link-classic")).toHaveAttribute("href", "/companies/c1");
      if (SHOTS) await snap(page, join(SHOTS, `01-durum-${vp}-${scheme}.png`));
      expect(calls.filter((c) => c.path.startsWith("/runs")).length).toBe(4);
      expect(calls.filter((c) => c.path.startsWith("/runs")).every((c) => c.path.includes("companyId=c1"))).toBe(true);
      expect(calls.filter((c) => c.method !== "GET" && c.method !== "OPTIONS" && !c.path.startsWith("/collaboration/"))).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    });
  });
}

test.describe("bayrak AÇIK: bilinmeyen kova, kısmi sayfa, hata", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("okunamayan kova 0 DEĞİL 'Bilinmiyor'; sunucu toplamı 25'ten büyükse de kesin; uzun ad taşmaz", async ({ page }) => {
    await prepare(page, "dark");
    await mockApi(page, {
      company: { status: 200, body: { ...COMPANY, name: "Çok uzun bir şirket adı: Kuzey Yakası Dış Ticaret ve Lojistik Hizmetleri Anonim Şirketi İstanbul Şubesi", agents: [] } },
      buckets: { stuck: { status: 500 }, working: { status: 200, body: { runs: BUCKETS.working.runs.slice(0, 2), nextCursor: "cur-2", counts: { working: 40, stuck: 0, needs_approval: 1, done: 1 } } } },
    });
    await page.goto(`${UI_LAB}/companies/c1/status`);
    const line = page.getByTestId("company-summary-line");
    await expect(line).toContainText("Çalışan 40 · Takılan Bilinmiyor · Onay bekleyen 1");
    await expect(page.getByTestId("company-agents-empty")).toBeVisible();
    // Kısmi sayfa/okunamayan kova varken maliyet de "en az"; ekran okuyucu özeti okunamayan kovayı 0 okumaz.
    await expect(line).toContainText(/Maliyet en az /);
    await expect(page.getByTestId("company-live")).toHaveText("1 onay bekliyor, Bilinmiyor takıldı");
    if (SHOTS) await snap(page, join(SHOTS, "02-bilinmiyor-kismi-mobil-390-dark.png"));
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  });

  test("şirket 404 → uyarı, sayı YOK; yeniden dene çalışır", async ({ page }) => {
    await prepare(page, "dark");
    const opts: MockOpts = { company: { status: 404 } };
    await mockApi(page, opts);
    await page.goto(`${UI_LAB}/companies/c1/status`);
    const err = page.getByTestId("company-error");
    await expect(err).toContainText("Şirket yüklenemedi");
    expect(await page.getByTestId("company-summary").count()).toBe(0);
    delete opts.company;
    await err.getByRole("button", { name: "Yeniden dene" }).click();
    await expect(page.getByTestId("company-summary-line")).toBeVisible();
    await expect(page.getByTestId("company-error")).toHaveCount(0);
  });
});

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";
import { describe, it, expect } from "vitest";
import CodeChangeCard, { type CodeState } from "../../components/job/CodeChangeCard";
import { uxCodeEnabled } from "./flag";
import { count, hasCodeChange, parseCodeSummary } from "./summary";
import { codeSig, isAwaitingApproval, planCodeFetch } from "./refresh";

const dir = join(__dirname, "..", "..", "messages");
const messages = (loc: string) => JSON.parse(readFileSync(join(dir, `${loc}.json`), "utf8"));
const mkT = (loc: string) => {
  const tr = createTranslator({ locale: loc, messages: messages(loc) });
  return ((k: string, v?: Record<string, string | number>) => (tr as any)(k, v)) as (k: string, v?: Record<string, string | number>) => string;
};
const html = (state: CodeState | null, over: Partial<{ title: string; awaitingApproval: boolean; locale: string; rtl: boolean; headingLevel: 2 | 3 }> = {}) => {
  const locale = over.locale ?? "en";
  return renderToStaticMarkup(<CodeChangeCard state={state} title={over.title ?? "Fix login"} awaitingApproval={over.awaitingApproval ?? false} t={mkT(locale)} locale={locale} rtl={over.rtl ?? false} headingLevel={over.headingLevel} onRetry={() => {}} />);
};
const ready = (raw: unknown): CodeState => ({ status: "ready", view: parseCodeSummary(raw)! });
const FULL = {
  runId: "r1",
  diff: { files: [{ path: "src/auth.ts", additions: 12, deletions: 4 }, { path: "src/b.ts", additions: 1, deletions: 0 }], fileCount: 2, additions: 13, deletions: 4, complete: true },
  tests: { passed: 41, failed: 0, skipped: 2, total: 43, ok: true, runs: 1 },
  generatedAt: "2026-11-13T00:00:00Z",
};

describe("bayrak", () => {
  it("varsayılan kapalı; yalnız 1/true açar", () => {
    expect(uxCodeEnabled({})).toBe(false);
    for (const v of ["", "0", "false", "yes"]) expect(uxCodeEnabled({ NEXT_PUBLIC_UX_CODE: v })).toBe(false);
    for (const v of ["1", "true", " TRUE "]) expect(uxCodeEnabled({ NEXT_PUBLIC_UX_CODE: v })).toBe(true);
  });
});

describe("parseCodeSummary (savunmacı)", () => {
  it("nesne olmayan yanıt → null", () => {
    for (const v of [null, undefined, 5, "x", [], true]) expect(parseCodeSummary(v)).toBeNull();
  });
  it("sayı: negatif/NaN/Infinity/ondalık/dize → null; geçerli tam sayı korunur (0 dahil)", () => {
    for (const v of [-1, NaN, Infinity, 1.5, "3", null, undefined, {}]) expect(count(v)).toBeNull();
    expect(count(0)).toBe(0);
    expect(count(12)).toBe(12);
  });
  it("diff ve tests yok/yanlış tipli → ikisi de null, kayıt yok", () => {
    const v = parseCodeSummary({ runId: "r", diff: "x", tests: [1] })!;
    expect(v).toEqual({ diff: null, tests: null });
    expect(hasCodeChange(v)).toBe(false);
  });
  it("files dizi değilse boş; yolu dize olmayan/boş dosya atılır; sayılar savunmacı", () => {
    const v = parseCodeSummary({ diff: { files: "x", fileCount: 3, additions: -2, deletions: 4, complete: "true" }, tests: null })!;
    expect(v.diff).toEqual({ files: [], fileCount: 3, additions: null, deletions: 4, complete: false });
    const w = parseCodeSummary({ diff: { files: [{ path: 3 }, { path: "" }, null, { path: "a.ts", additions: NaN, deletions: 2 }], fileCount: 0, additions: 0, deletions: 0, complete: true } })!;
    expect(w.diff!.files).toEqual([{ path: "a.ts", additions: null, deletions: 2 }]);
    expect(w.diff!.fileCount).toBe(1); // fileCount hiçbir zaman gösterilen dosyadan küçük olmaz
  });
  it("tests: ok yalnız açık true; bilinmeyen alan null; runs sayı değilse null", () => {
    const v = parseCodeSummary({ tests: { passed: "41", failed: 0, skipped: -1, total: undefined, ok: "yes", runs: "2" } })!;
    expect(v.tests).toEqual({ passed: null, failed: 0, skipped: null, total: null, ok: false, runs: null });
  });
});

describe("fileCount bilinmiyorsa", () => {
  it("{diff:{}} → fileCount null (0 uydurulmaz), dosya yok, complete false", () => {
    expect(parseCodeSummary({ diff: {} })!.diff).toEqual({ files: [], fileCount: null, additions: null, deletions: null, complete: false });
    expect(parseCodeSummary({ diff: { files: [{ path: "a.ts" }], fileCount: -1 } })!.diff!.fileCount).toBeNull();
  });
  it("kart 'Dosyalar (Bilinmiyor)' yazar, '+K daha' yok", () => {
    const h = html(ready({ diff: { files: [{ path: "a.ts", additions: 1, deletions: 1 }] }, tests: null }));
    expect(h).toContain("Files (Unknown)");
    expect(h).not.toContain("Files (0)");
    expect(h).not.toContain("more file");
    expect(h).not.toMatch(/Files \(\d/);
  });
});

describe("sayı yerelleştirme ve başlık seviyesi", () => {
  const big = { diff: { files: [{ path: "a.ts", additions: 1, deletions: 1 }], fileCount: 1001, additions: 1, deletions: 1, complete: false }, tests: { passed: 1, failed: 0, skipped: 0, total: 1, ok: true, runs: 1000 } };
  it("'+K daha' ve 'N test koşusu' yerelleştirilir (çoğullu ve çoğulsuz dil)", () => {
    const en = html(ready(big));
    expect(en).toContain("+1,000 more files");
    expect(en).toContain("1,000 test runs");
    const tr = html(ready(big), { locale: "tr" });
    expect(tr).toContain("+1.000 dosya daha");
    expect(tr).toContain("1.000 test koşusu");
    expect(html(ready({ ...big, diff: { ...big.diff, fileCount: 2 } }))).toContain("+1 more file<");
  });
  it("headingLevel: varsayılan h3, iş sayfasında h2", () => {
    expect(html(ready(FULL))).toMatch(/<h3[ >]/);
    const h = html(ready(FULL), { headingLevel: 2 });
    expect(h).toMatch(/<h2[ >]/);
    expect(h).not.toContain("<h3");
  });
});

describe("kod özeti yenileme planı", () => {
  const sig = (u: string, st = "RUNNING") => codeSig({ id: "r1", updatedAt: u, state: st as any, status: "RUNNING" });
  it("ilk çekim, aynı imza → yok, değişen updatedAt/durum → sessiz, başka iş → çekim", () => {
    expect(planCodeFetch(null, sig("1"), "none")).toBe("fetch");
    expect(planCodeFetch(sig("1"), sig("1"), "ready")).toBe("none");
    expect(planCodeFetch(sig("1"), sig("2"), "ready")).toBe("silent");
    expect(planCodeFetch(sig("1"), sig("1", "COMPLETED"), "ready")).toBe("silent");
    expect(planCodeFetch(sig("1"), codeSig({ id: "r2", updatedAt: "1", state: "RUNNING", status: "RUNNING" }), "ready")).toBe("fetch");
  });
  it("hata/yükleniyor durumunda imza değişirse görünür çekim; aynı imzada hata döngüsü yok", () => {
    expect(planCodeFetch(sig("1"), sig("2"), "error")).toBe("fetch");
    expect(planCodeFetch(sig("1"), sig("2"), "loading")).toBe("fetch");
    expect(planCodeFetch(sig("1"), sig("1"), "error")).toBe("none");
  });
});

describe("onay bağlantısı koşulu", () => {
  it("etkin duruma bakar: state null + status WAITING_APPROVAL → onay bekliyor", () => {
    expect(isAwaitingApproval({ state: null, status: "WAITING_APPROVAL" })).toBe(true);
    expect(isAwaitingApproval({ state: "NEEDS_APPROVAL", status: "RUNNING" })).toBe(true);
    expect(isAwaitingApproval({ state: null, status: "RUNNING" })).toBe(false);
    expect(isAwaitingApproval({ state: "COMPLETED", status: "WAITING_APPROVAL" })).toBe(false);
  });
});

describe("CodeChangeCard işaretlemesi", () => {
  it("state null → hiçbir şey çizilmez (bayrak kapalı yolu kartı hiç vermez)", () => {
    expect(html(null)).toBe("");
  });
  it("yükleniyor / hata (Yeniden dene) / yok", () => {
    expect(html({ status: "loading" })).toContain("Loading the code change");
    const e = html({ status: "error" });
    expect(e).toContain('role="alert"');
    expect(e).toContain("Try again");
    const n = html(ready({ diff: null, tests: null }));
    expect(n).toContain("This job has no code change record.");
    expect(n).not.toContain("code-files");
  });
  it("bayat (sessiz yenileme başarısız): eski veri yerinde + 'güncellenemedi' notu (alert değil) + Yeniden dene; taze veride yok", () => {
    const s = html({ ...(ready(FULL) as Extract<CodeState, { status: "ready" }>), stale: true });
    expect(s).toContain("src/auth.ts");
    expect(s).toContain("41 passed");
    expect(s).toContain('data-testid="code-stale"');
    expect(s).toContain("Couldn&#x27;t refresh; showing the last known data.");
    expect(s).toContain("Try again");
    expect(s).not.toContain('role="alert"');
    const fresh = html(ready(FULL));
    expect(fresh).not.toContain("code-stale");
    expect(fresh).not.toContain("<button");
    expect(html({ ...(ready(FULL) as Extract<CodeState, { status: "ready" }>), stale: true }, { locale: "tr" })).toContain("Yenilenemedi; son bilinen veri gösteriliyor.");
  });
  it("hazır: başlık, dosya satırı +12 −4, testler, doğrulandı; Kabul/Reddet düğmesi yok", () => {
    const h = html(ready(FULL));
    expect(h).toContain("Change: Fix login");
    expect(h).toContain("Files (2)");
    expect(h).toContain("src/auth.ts");
    expect(h).toContain("+12");
    expect(h).toContain("−4");
    expect(h).toContain("Total: +13 −4");
    expect(h).toContain("41 passed · 0 failed · 2 skipped");
    expect(h).toContain("✓ Verified");
    expect(h).not.toContain("At least");
    expect(h).not.toContain("<button");
    expect(h).not.toMatch(/Accept|Reject|Kabul|Reddet|soon/i);
    expect(h).not.toContain("code-approvals-link");
  });
  it("sayı null → Bilinmiyor (0 değil)", () => {
    const h = html(ready({ diff: { files: [{ path: "a.ts", additions: null, deletions: null }], fileCount: 1, additions: null, deletions: null, complete: false }, tests: { passed: null, failed: null, skipped: null, total: null, ok: false, runs: 1 } }));
    expect(h).not.toContain("Total:");
    expect(h).toContain("At least: Unknown Unknown");
    expect(h).toContain("passed: Unknown · failed: Unknown · skipped: Unknown");
    expect(h.match(/>Unknown</g)!.length).toBeGreaterThanOrEqual(2);
    expect(h).not.toContain("+0");
    expect(h).not.toContain("0 passed");
  });
  it("complete:false → 'En az' ve not; ok:false → Doğrulanmadı işareti (metin + simge)", () => {
    const h = html(ready({ diff: { files: [{ path: "a.ts", additions: 3, deletions: 1 }], fileCount: 1, additions: 3, deletions: 1, complete: false }, tests: { passed: 5, failed: 2, skipped: 0, total: 7, ok: false, runs: 1 } }));
    expect(h).toContain("At least: +3 −1");
    expect(h).toContain("lower bound");
    expect(h).toContain("! Not verified");
    expect(h).toContain("5 passed · 2 failed");
    expect(h).not.toContain("skipped");
  });
  it("kırpılmış liste → '+K dosya daha'; runs>1 → N test koşusu", () => {
    const h = html(ready({ diff: { files: [{ path: "a.ts", additions: 1, deletions: 1 }], fileCount: 4, additions: 1, deletions: 1, complete: false }, tests: { passed: 1, failed: 0, skipped: 0, total: 1, ok: true, runs: 3 } }));
    expect(h).toContain("+3 more files");
    expect(h).toContain("3 test runs");
    expect(html(ready({ diff: null, tests: { passed: 1, failed: 0, skipped: 0, total: 1, ok: true, runs: 1 } }))).not.toContain("test run");
  });
  it("yalnız tests / yalnız diff: eksik taraf Bilinmiyor", () => {
    const a = html(ready({ diff: null, tests: FULL.tests }));
    expect(a).toContain("Files: Unknown");
    const b = html(ready({ diff: FULL.diff, tests: null }));
    expect(b).toMatch(/Tests:<\/strong><span>Unknown</);
    expect(b).not.toContain("Verified");
  });
  it("onay bekliyorsa /approvals bağlantısı; başka eylem yok", () => {
    const h = html(ready(FULL), { awaitingApproval: true });
    expect(h).toContain('href="/approvals"');
    expect(h).toContain("Decide in the approval center");
    expect(h).not.toContain("<button");
  });
  it("ekran okuyucu özeti okunamayanı 0 okumaz", () => {
    const h = html(ready({ diff: { files: [], fileCount: 0, additions: null, deletions: null, complete: false }, tests: { passed: null, failed: null, skipped: null, total: null, ok: false, runs: 1 } }));
    expect(h).toMatch(/data-testid="code-live"[^>]*>[^<]*Unknown Unknown[^<]*passed: Unknown/);
  });
  it("RTL (ar): dir=rtl, yol dir=ltr; Türkçe metinler", () => {
    const h = html(ready(FULL), { locale: "ar", rtl: true });
    expect(h).toContain('dir="rtl"');
    expect(h).toContain('<code dir="ltr"');
    const tr = html(ready(FULL), { locale: "tr" });
    expect(tr).toContain("Değişiklik: Fix login");
    expect(tr).toContain("41 geçti · 0 kaldı · 2 atlandı");
    expect(tr).toContain("Dosyalar (2)");
  });
});

describe("i18n: app.codeChange tüm dillerde", () => {
  const flat = (o: any, p = ""): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
  const get = (o: any, k: string) => k.split(".").reduce((a: any, p) => a[p], o) as string;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const en = messages("en").app.codeChange;
  // Yer tutucu adları (ICU çoğul ile düz sayaç aynı sayılır).
  const ph = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\s*[,}]/g)].map((m) => m[1]))].sort().join();
  for (const f of files) it(`${f}: anahtar kümesi, boş değer yok, yer tutucular en ile aynı`, () => {
    const m = JSON.parse(readFileSync(join(dir, f), "utf8")).app.codeChange;
    expect(flat(m).sort()).toEqual(flat(en).sort());
    for (const k of flat(m)) { expect(get(m, k)).toMatch(/\S/); expect(ph(get(m, k)), `${f}:${k}`).toBe(ph(get(en, k))); }
  });
});

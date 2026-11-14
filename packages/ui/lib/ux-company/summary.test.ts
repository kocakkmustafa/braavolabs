import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { InboxRun, InboxRunsPage } from "../inbox";
import { parseRunsPage } from "../inboxParse";
import { uxCompanyEnabled } from "./flag";
import { companyName, summarizeCompany, toAgentRows, type BucketPages } from "./summary";

const run = (id: string, companyId: string | null, cost: unknown, bucket = "working"): InboxRun => ({
  id, pipelineId: "p", status: "RUNNING", state: null, resultStatus: null, costUsd: cost as any, createdAt: "2026-11-13T00:00:00Z", updatedAt: "2026-11-13T00:00:00Z",
  bucket: bucket as any, pipeline: companyId ? { id: "p", name: "x", company: { id: companyId, name: "C" } } : null,
});
const page = (runs: InboxRun[], nextCursor: string | null = null, counts?: InboxRunsPage["counts"]): InboxRunsPage => ({ runs, nextCursor, ...(counts ? { counts } : {}) });
const C = (working = 0, stuck = 0, needs_approval = 0, done = 0) => ({ working, stuck, needs_approval, done });
const pages = (over: Partial<BucketPages> = {}, counts = C()): BucketPages => ({ working: page([], null, counts), stuck: page([], null, counts), needs_approval: page([], null, counts), done: page([], null, counts), ...over });

describe("bayrak", () => {
  it("varsayılan kapalı; yalnız 1/true açar", () => {
    expect(uxCompanyEnabled({})).toBe(false);
    for (const v of ["", "0", "false", "yes"]) expect(uxCompanyEnabled({ NEXT_PUBLIC_UX_COMPANY: v })).toBe(false);
    for (const v of ["1", "true", " TRUE "]) expect(uxCompanyEnabled({ NEXT_PUBLIC_UX_COMPANY: v })).toBe(true);
  });
});

describe("summarizeCompany", () => {
  it("sayılar sunucu `counts` toplamıdır (istemci süzmesi yok); maliyet yüklenen işlerden", () => {
    const s = summarizeCompany(pages({ working: page([run("a", "c1", "1.5")], null, C(1, 0, 0, 1)), done: page([run("d", "c1", 2, "done")], null, C(1, 0, 0, 1)) }, C(1, 0, 0, 1)));
    expect(s.counts.working).toEqual({ count: 1, partial: false });
    expect(s.counts.done).toEqual({ count: 1, partial: false });
    expect(s.costUsd).toBe(3.5);
    expect(s.costUnknownRuns).toBe(0);
    expect(s.costPartial).toBe(false);
  });
  it("25+ kayıt: sayfa 25'te kesilse de toplam sunucu sayısıdır (en az DEĞİL kesin)", () => {
    const runs = Array.from({ length: 25 }, (_, i) => run(`r${i}`, "c1", "1"));
    const c = C(40, 3, 4, 12);
    const s = summarizeCompany(pages({ working: page(runs, "cur", c) }, c));
    expect(s.counts.working).toEqual({ count: 40, partial: false });
    expect(s.counts.stuck.count! + s.counts.needs_approval.count! + s.counts.done.count! + s.counts.working.count!).toBe(59);
    expect(s.costPartial).toBe(true); // maliyet yalnız yüklenen 25 işten
  });
  it("okunamayan kova 0 DEĞİL bilinmiyor (null); maliyet kısmi işaretlenir", () => {
    const s = summarizeCompany(pages({ stuck: null }));
    expect(s.counts.stuck).toEqual({ count: null, partial: false });
    expect(s.counts.working.count).toBe(0);
    expect(s.costPartial).toBe(true);
  });
  it("`counts` gelmediyse (eski sunucu) sayı bilinmiyor; istemci tahmin etmez", () => {
    const s = summarizeCompany({ working: page([run("a", "c1", null)]), stuck: page([]), needs_approval: page([]), done: page([]) });
    expect(s.counts.working).toEqual({ count: null, partial: false });
    expect(s.costPartial).toBe(true);
  });
  it("maliyet: bozuk/null değer toplama girmez ve sayılır; hiç okunamazsa costUsd null; 0 maliyet 0'dır", () => {
    const bad = summarizeCompany(pages({ working: page([run("a", "c1", null), run("b", "c1", "12,5")], null, C(2)) }));
    expect(bad.costUsd).toBeNull();
    expect(bad.costUnknownRuns).toBe(2);
    const zero = summarizeCompany(pages({ working: page([run("a", "c1", "0.000000")], null, C(1)) }));
    expect(zero.costUsd).toBe(0);
  });
  it("hiç iş yoksa maliyet 0 (bilinmiyor DEĞİL); kova okunamadıysa bilinmiyor", () => {
    expect(summarizeCompany(pages()).costUsd).toBe(0);
    expect(summarizeCompany(pages({ done: null })).costUsd).toBeNull();
  });
  it("ondalık toplam kayan nokta hatası üretmez (0.1+0.2)", () => {
    const s = summarizeCompany(pages({ working: page([run("a", "c1", "0.1"), run("b", "c1", "0.2")], null, C(2)) }));
    expect(s.costUsd).toBe(0.3);
  });
});

describe("parseRunsPage counts", () => {
  it("geçerli counts okunur; bozuk kova atlanır (0 uydurulmaz); counts yoksa alan yok", () => {
    const base = { runs: [], nextCursor: null };
    expect(parseRunsPage({ ...base, counts: { working: 3, stuck: -1, done: 2.5, needs_approval: "4" } }).counts).toEqual({ working: 3 });
    expect(parseRunsPage(base)).not.toHaveProperty("counts");
    expect(parseRunsPage({ ...base, counts: [1] })).not.toHaveProperty("counts");
  });
});

describe("toAgentRows / companyName", () => {
  it("geçerli ajanlar okunur; bozuk satır ve eksik rol çökertmez", () => {
    expect(toAgentRows({ agents: [{ id: "a1", name: "Satış", role: "sales_agent" }, { id: "a2", name: "Yazar" }, { id: 3, name: "x" }, null, { id: "a4", name: " " }] }))
      .toEqual([{ id: "a1", name: "Satış", role: "sales_agent" }, { id: "a2", name: "Yazar", role: null }]);
    expect(toAgentRows(null)).toEqual([]);
    expect(toAgentRows({ agents: "x" })).toEqual([]);
  });
  it("şirket adı", () => {
    expect(companyName({ name: "Atölye" })).toBe("Atölye");
    expect(companyName({ name: " " })).toBeNull();
    expect(companyName(null)).toBeNull();
  });
});

describe("i18n: app.companyStatus 15 dilde aynı anahtarlar ve yer tutucular", () => {
  const dir = join(__dirname, "../../messages");
  const flat = (o: any, p = ""): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
  const get = (o: any, k: string) => k.split(".").reduce((a: any, p) => a[p], o) as string;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const en = JSON.parse(readFileSync(join(dir, "en.json"), "utf8")).app.companyStatus;
  const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
  for (const f of files) it(`${f}: anahtar kümesi, boş değer yok, yer tutucular en ile aynı`, () => {
    const m = JSON.parse(readFileSync(join(dir, f), "utf8")).app.companyStatus;
    expect(flat(m).sort()).toEqual(flat(en).sort());
    for (const k of flat(m)) { expect(get(m, k)).toMatch(/\S/); expect(ph(get(m, k)), `${f}:${k}`).toBe(ph(get(en, k))); }
  });
});

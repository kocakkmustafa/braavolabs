import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { InboxRun, InboxRunsPage } from "../inbox";
import { uxCompanyEnabled } from "./flag";
import { companyName, summarizeCompany, toAgentRows, type BucketPages } from "./summary";

const run = (id: string, companyId: string | null, cost: unknown, bucket = "working"): InboxRun => ({
  id, pipelineId: "p", status: "RUNNING", state: null, resultStatus: null, costUsd: cost as any, createdAt: "2026-11-13T00:00:00Z", updatedAt: "2026-11-13T00:00:00Z",
  bucket: bucket as any, pipeline: companyId ? { id: "p", name: "x", company: { id: companyId, name: "C" } } : null,
});
const page = (runs: InboxRun[], nextCursor: string | null = null): InboxRunsPage => ({ runs, nextCursor });
const pages = (over: Partial<BucketPages> = {}): BucketPages => ({ working: page([]), stuck: page([]), needs_approval: page([]), done: page([]), ...over });

describe("bayrak", () => {
  it("varsayılan kapalı; yalnız 1/true açar", () => {
    expect(uxCompanyEnabled({})).toBe(false);
    for (const v of ["", "0", "false", "yes"]) expect(uxCompanyEnabled({ NEXT_PUBLIC_UX_COMPANY: v })).toBe(false);
    for (const v of ["1", "true", " TRUE "]) expect(uxCompanyEnabled({ NEXT_PUBLIC_UX_COMPANY: v })).toBe(true);
  });
});

describe("summarizeCompany", () => {
  it("yalnız bu şirketin işlerini sayar; başka şirket ve şirketsiz işler dışarıda", () => {
    const s = summarizeCompany("c1", pages({ working: page([run("a", "c1", "1.5"), run("b", "c2", "9"), run("c", null, "9")]), done: page([run("d", "c1", 2, "done")]) }));
    expect(s.counts.working).toEqual({ count: 1, partial: false });
    expect(s.counts.done).toEqual({ count: 1, partial: false });
    expect(s.costUsd).toBe(3.5);
    expect(s.costUnknownRuns).toBe(0);
    expect(s.costPartial).toBe(false);
  });
  it("okunamayan kova 0 DEĞİL bilinmiyor (null); maliyet kısmi işaretlenir", () => {
    const s = summarizeCompany("c1", pages({ stuck: null }));
    expect(s.counts.stuck).toEqual({ count: null, partial: false });
    expect(s.counts.working.count).toBe(0);
    expect(s.costPartial).toBe(true);
  });
  it("sonraki sayfa varsa sayı 'en az' (partial)", () => {
    const s = summarizeCompany("c1", pages({ needs_approval: page([run("a", "c1", null)], "cur") }));
    expect(s.counts.needs_approval).toEqual({ count: 1, partial: true });
    expect(s.costPartial).toBe(true);
  });
  it("maliyet: bozuk/null değer toplama girmez ve sayılır; hiç okunamazsa costUsd null; 0 maliyet 0'dır", () => {
    const bad = summarizeCompany("c1", pages({ working: page([run("a", "c1", null), run("b", "c1", "12,5")]) }));
    expect(bad.costUsd).toBeNull();
    expect(bad.costUnknownRuns).toBe(2);
    const zero = summarizeCompany("c1", pages({ working: page([run("a", "c1", "0.000000")]) }));
    expect(zero.costUsd).toBe(0);
  });
  it("hiç iş yoksa maliyet 0 (bilinmiyor DEĞİL); kova okunamadıysa bilinmiyor", () => {
    expect(summarizeCompany("c1", pages()).costUsd).toBe(0);
    expect(summarizeCompany("c1", pages({ done: null })).costUsd).toBeNull();
  });
  it("ondalık toplam kayan nokta hatası üretmez (0.1+0.2)", () => {
    const s = summarizeCompany("c1", pages({ working: page([run("a", "c1", "0.1"), run("b", "c1", "0.2")]) }));
    expect(s.costUsd).toBe(0.3);
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

/** BRA-P2-05 — Kaput koşu olay günlüğü: ayrıştırma, görünüm (maske, N satır, daha fazla), geri uyum, istemci, 15 dil. */
import React from "react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
import KaputPanel from "../../components/job/KaputPanel";
import type { T } from "../../components/inbox/InboxParts";
import { parseKaput, type Kaput } from "../ux-kaput/facts";
import { ACTIVITY_MAX_LINES, parseActivity } from "./activity";

const getRun = vi.hoisted(() => vi.fn());
const listHandoffs = vi.hoisted(() => vi.fn());
const getRunActivity = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ api: { getRun, listHandoffs, getRunActivity } }));
import { loadKaput } from "../ux-jobs/kaput";

const t: T = (key, v) => (v ? `${key}${JSON.stringify(v)}` : key);
const RAW = { costUsd: 0.1, steps: [{ id: "s1", stepIndex: 0, name: "Topla", status: "COMPLETED", startedAt: "2026-11-16T10:00:00Z", completedAt: "2026-11-16T10:00:05Z", toolCalls: [] }] };
const item = (n: number, over: Record<string, unknown> = {}) => ({ id: `a${n}`, action: "run.stop", at: `2026-11-16T10:00:${String(n % 60).padStart(2, "0")}.000Z`, actor: "cmabcdefghijklmn", summary: "Run stopped", ...over });
const kaput = (activity: Kaput["activity"]): Kaput => ({ ...parseKaput(RAW), handoffCount: 0, activity });
const render = (k: Kaput, full = true, locale = "tr") => renderToStaticMarkup(<KaputPanel load={{ status: "ready", kaput: k }} full={full} t={t} locale={locale} onRetry={() => {}} />).replace(/&quot;/g, '"');

describe("parseActivity", () => {
  it("geçerli yanıt: actor yalnız system/user ayrımı (kimlik atılır), hasMore nextCursor'dan", () => {
    const a = parseActivity({ items: [item(1), item(2, { actor: "system" }), item(3, { actor: undefined })], nextCursor: "abc" })!;
    expect(a.items.map((i) => i.actor)).toEqual(["user", "system", null]);
    expect(JSON.stringify(a)).not.toContain("cmabcdefghijklmn");
    expect(a.hasMore).toBe(true);
  });
  it("bozuk kalemler atlanır; biçim tutmazsa null", () => {
    expect(parseActivity({ items: [item(1), null, { id: 5 }, item(2, { at: "nope" }), item(3, { summary: 7 })], nextCursor: null })!.items).toHaveLength(1);
    for (const bad of [null, [], "x", {}, { items: "x" }]) expect(parseActivity(bad)).toBeNull();
    expect(parseActivity({ items: [], nextCursor: null })).toEqual({ items: [], hasMore: false, truncated: false });
  });
});

describe("KaputPanel olay günlüğü", () => {
  it("Tam: bölüm, başlık, sıralı liste, time dateTime, a11y (aria-labelledby, ol)", () => {
    const h = render(kaput(parseActivity({ items: [item(2), item(1, { actor: "system", summary: "Approval requested · step 1" })], nextCursor: null })));
    expect(h).toContain('data-testid="job-kaput-activity"');
    expect(h).toContain("app.jobs.kaput.activity.title");
    expect(h).toContain('dateTime="2026-11-16T10:00:02.000Z"');
    expect(h).toContain("app.jobs.kaput.activity.actorSystem");
    expect(h).toContain("app.jobs.kaput.activity.actorUser");
    expect(h).toMatch(/<section aria-labelledby="[^"]+" data-testid="job-kaput-activity"/);
    expect(h).toContain("<ol");
  });
  it("Sade kipte gösterilmez", () => {
    expect(render(kaput(parseActivity({ items: [item(1)], nextCursor: null })), false)).not.toContain("job-kaput-activity");
  });
  it("en fazla N satır + 'daha fazla' notu; nextCursor varken de not", () => {
    const many = Array.from({ length: ACTIVITY_MAX_LINES + 1 }, (_, i) => item(i + 1));
    const h = render(kaput(parseActivity({ items: many, nextCursor: null })));
    expect(h.match(/<time /g)).toHaveLength(ACTIVITY_MAX_LINES);
    expect(h).toContain(`app.jobs.kaput.activity.more{"count":${ACTIVITY_MAX_LINES}}`);
    expect(render(kaput(parseActivity({ items: [item(1)], nextCursor: "c" })))).toContain("job-kaput-activity-more");
    expect(render(kaput(parseActivity({ items: [item(1)], nextCursor: null })))).not.toContain("job-kaput-activity-more");
  });
  it("özet maskelenir ve düz metin basılır (HTML kaçışlı)", () => {
    const h = render(kaput(parseActivity({ items: [item(1, { summary: "Run stopped Bearer abcdefghijklmnop sk-ant-api03-SECRETSECRET <img src=x onerror=1>" })], nextCursor: null })));
    expect(h).not.toContain("abcdefghijklmnop");
    expect(h).not.toContain("SECRETSECRET");
    expect(h).not.toContain("<img");
    expect(h).toContain("[gizlendi]");
  });
  it("RTL: özet dir=auto; uzun özet kırpılır", () => {
    const h = render(kaput(parseActivity({ items: [item(1, { summary: "kisa kelime ".repeat(40) })], nextCursor: null })), true, "ar");
    expect(h).toContain('dir="auto"');
    expect(h).toContain("…");
  });
  it("geri uyum: activity yok/null/boş → bölüm yok; adım başlangıç/bitiş günlüğü korunur", () => {
    for (const a of [undefined, null, { items: [], hasMore: false, truncated: false }]) {
      const h = render(kaput(a as Kaput["activity"]));
      expect(h).not.toContain("job-kaput-activity");
      expect(h).toContain("app.jobs.kaput.logEvent.started");
      expect(h).toContain("app.jobs.kaput.logEvent.ended");
    }
  });
});

describe("truncated notu", () => {
  it("truncated:true → not görünür; yoksa görünmez", () => {
    expect(render(kaput(parseActivity({ items: [item(1)], nextCursor: null, truncated: true })))).toContain("app.jobs.kaput.activity.truncated");
    expect(render(kaput(parseActivity({ items: [item(1)], nextCursor: null })))).not.toContain("job-kaput-activity-truncated");
  });
});

describe("loadKaput + 15 dil", () => {
  it("uç hata verirse Kaput yine yüklenir (activity null); başarıda ayrıştırılır", async () => {
    getRun.mockResolvedValue(RAW);
    listHandoffs.mockResolvedValue({ handoffs: [] });
    getRunActivity.mockRejectedValueOnce(new Error("404"));
    expect((await loadKaput("tok", "r1")).activity).toBeNull();
    getRunActivity.mockResolvedValueOnce({ items: [item(1)], nextCursor: null });
    const k = await loadKaput("tok", "r1");
    expect(k.activity?.items).toHaveLength(1);
    expect(getRunActivity).toHaveBeenLastCalledWith("tok", "r1", ACTIVITY_MAX_LINES + 1);
  });
  it("4 yeni anahtar tüm dil dosyalarında var ve boş değil", () => {
    const dir = join(__dirname, "../../messages");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(15);
    for (const f of files) {
      const a = JSON.parse(readFileSync(join(dir, f), "utf8")).app.jobs.kaput.activity;
      for (const k of ["title", "actorSystem", "actorUser", "more", "truncated"]) expect(typeof a[k] === "string" && a[k].length > 0, `${f}:${k}`).toBe(true);
      expect(a.more).toContain("{count}");
    }
  });
});

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ApiRequestError } from "./api";
import { decideResult, decisionMessageKey, receiptFailureKind, refreshesLists, trySend } from "./inboxActions";
import {
  createRowLock, failLoad, finishLoad, refreshGroupsFirstPage, refreshRunsFirstPage, startLoad, type Load,
} from "./inboxState";
import { allowedActions, mergeById } from "./inbox";
import { ApprovalGroups, type T } from "../components/inbox/InboxParts";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: any) => <a href={href} {...p}>{children}</a> }));
const t: T = (key, v) => v ? `${key}${JSON.stringify(v)}` : key;
const noop = () => {};

describe("onay kararı sonucu (ENGEL 1, 5)", () => {
  it("claimFailed:true görünür sonuç üretir (sessiz yenileme değil)", async () => {
    const r = await decideResult(async () => ({ success: true, decision: "APPROVED", claimFailed: true, error: "claim failed" }));
    expect(r).toEqual({ kind: "claimFailed" });
    expect(refreshesLists(r.kind)).toBe(true);
  });
  it("normal onay ok; yenileme yapılır", async () => {
    const r = await decideResult(async () => ({ success: true, decision: "APPROVED" }));
    expect(r.kind).toBe("ok");
  });
  it("403 yetki mesajı, kart yerinde kalır (yenileme yok)", async () => {
    const r = await decideResult(async () => { throw new ApiRequestError(403, "x"); });
    expect(r.kind).toBe("forbidden");
    expect(decisionMessageKey(r.kind)).toBe("app.inbox.approvalForbidden");
    expect(refreshesLists(r.kind)).toBe(false);
  });
  it("404 ve 409 bayat kartı yenilemeyle düşürür", async () => {
    for (const s of [404, 409]) {
      const r = await decideResult(async () => { throw new ApiRequestError(s, "x"); });
      expect(r.kind).toBe("stale");
      expect(refreshesLists(r.kind)).toBe(true);
    }
    expect((await decideResult(async () => { throw new Error("net"); })).kind).toBe("error");
  });
  it("bozuk yanıt şekli (parseApprovalDecision fırlatır) genel hata", async () => {
    const r = await decideResult(async () => { throw new Error("Invalid approval decision response."); });
    expect(decisionMessageKey(r.kind)).toBe("app.inbox.approvalFailed");
  });
});

describe("sayfa durum makinesi (ENGEL 7)", () => {
  const ready = (ids: string[], cursor: string | null = "c1"): Load<{ id: string }[]> => ({ status: "ready", data: ids.map((id) => ({ id })), cursor, more: false, moreError: false });
  it("hata durumunda 'Yeniden dene' yeniden istek durumuna (loading) geçer", () => {
    const err = failLoad<{ id: string }[]>({ status: "loading" }, null, false);
    expect(err.status).toBe("error");
    expect(startLoad(err, null, false)).toEqual({ status: "loading" });
  });
  it("load-more hatasında liste korunur ve hata bayrağı kalkar/kurulur", () => {
    const p = startLoad(ready(["a", "b"]), "c1", false);
    expect(p).toMatchObject({ more: true });
    const f = failLoad(p, "c1", false);
    expect(f).toMatchObject({ status: "ready", moreError: true, more: false });
    expect((f as any).data.map((x: any) => x.id)).toEqual(["a", "b"]);
  });
  it("ilk yükleme hatası asla boş liste değildir", () => {
    expect(failLoad<unknown[]>({ status: "loading" }, null, false)).toEqual({ status: "error" });
  });
  it("eylem sonrası sessiz yenileme: loading'e dönmez, liste ve sayfalama korunur, eylem yapılan satır düşer", () => {
    const prev = ready(["a", "b", "c"], "c9");
    expect(startLoad(prev, null, true)).toBe(prev);
    const next = finishLoad(prev, null, true, [{ id: "a" }, { id: "x" }], "cNew",
      (o, i) => mergeById(o, i), (o, i) => refreshRunsFirstPage(o, i, "b"), (o, i) => o.length > i.length);
    expect(next).toMatchObject({ status: "ready", cursor: "c9" });
    expect((next as any).data.map((x: any) => x.id)).toEqual(["a", "x", "c"]);
  });
  it("sessiz yenileme hatası listeyi korur", () => {
    expect(failLoad(ready(["a"]), null, true)).toMatchObject({ status: "ready", data: [{ id: "a" }] });
  });
  it("load-more sonrası ek sayfa birleşir (çift satır yok)", () => {
    const n = finishLoad(ready(["a"]), "c1", false, [{ id: "a" }, { id: "b" }], null, mergeById, (o) => o, () => false);
    expect((n as any).data.map((x: any) => x.id)).toEqual(["a", "b"]);
    expect(n).toMatchObject({ cursor: null });
  });
  it("onay grupları sessiz yenilemede karar verilen onay düşer, boş grup kalkar, yüklü eski satırlar korunur", () => {
    const ap = (id: string) => ({ id, runId: "r", status: "PENDING", createdAt: "x" });
    const old = [{ runId: "r", runTitle: "P", approvals: [ap("1"), ap("2")] }, { runId: "q", runTitle: null, approvals: [ap("3")] }];
    const out = refreshGroupsFirstPage(old, [{ runId: "r", runTitle: "P", approvals: [ap("2")] }], "3");
    expect(out.map((g) => [g.runId, g.approvals.map((a) => a.id)])).toEqual([["r", ["2", "1"]]]);
  });
});

describe("satır başına kilit (çift tıklama; ENGEL 7/8)", () => {
  it("aynı satır ikinci kez alınamaz; farklı satır bağımsız", () => {
    const l = createRowLock();
    expect(l.acquire("a")).toBe(true);
    expect(l.acquire("a")).toBe(false);
    expect(l.acquire("b")).toBe(true);
    l.release("a");
    expect(l.has("a")).toBe(false);
    expect(l.has("b")).toBe(true);
    expect(l.snapshot()).toEqual(new Set(["b"]));
  });
});

describe("steer, makbuz, PENDING", () => {
  it("steer: hata metni silmez (ok:false), başarı siler (ok:true)", async () => {
    expect((await trySend(async () => { throw new Error("x"); })).ok).toBe(false);
    expect((await trySend(async () => 1)).ok).toBe(true);
  });
  it("makbuz: yalnız receipt_not_found 404'ü 'yok'; koşu bulunamadı hata", () => {
    expect(receiptFailureKind(new ApiRequestError(404, "receipt_not_found"))).toBe("none");
    expect(receiptFailureKind(new ApiRequestError(404, "Run not found"))).toBe("error");
    expect(receiptFailureKind(new ApiRequestError(500, "x"))).toBe("error");
  });
  it("state boş + PENDING: stop gizli (bayrak kapalıyken API 400); state doluysa READY stop gösterir", () => {
    expect(allowedActions({ state: null, status: "PENDING", bucket: "working" })).toEqual(["steer"]);
    expect(allowedActions({ state: "READY", status: "PENDING", bucket: "working" })).toEqual(["steer", "stop"]);
  });
});

describe("onay kartı (ENGEL 2, 6)", () => {
  const base = { id: "a1", runId: "r1", status: "PENDING", createdAt: "2026-11-01T10:00:00Z" };
  const render = (a: any) => renderToStaticMarkup(<ApprovalGroups groups={[{ runId: "r1", runTitle: "P", approvals: [a] }]} busyIds={new Set()} errorByApproval={{}} onDecide={noop} t={t} locale="en" />);
  it("artifact düz metin gösterilir; HTML kaçar, bağlantılanmaz", () => {
    const html = render({ ...base, artifact: { kind: "email", title: "Merhaba", body: "<script>alert(1)</script> https://x.test" } });
    expect(html).toContain("Merhaba");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toMatch(/<a [^>]*href="https:\/\/x\.test/);
    expect(html).toContain("app.approvals.artifactKind.email");
  });
  it("expiresAt varsa gösterilir, yoksa gösterilmez", () => {
    expect(render({ ...base, expiresAt: "2026-11-02T10:00:00Z" })).toContain("app.inbox.expires");
    expect(render(base)).not.toContain("app.inbox.expires");
  });
  it("INPUT tipinde not zorunlu (boş notla Onayla devre dışı); SPEND'de not alanı yok", () => {
    const input = render({ ...base, type: "INPUT", description: "Hangi tarih?" });
    expect(input).toContain('id="answer-a1"');
    expect(input).toMatch(/<button[^>]*disabled=""[^>]*>app\.inbox\.approve/);
    const spend = render({ ...base, type: "SPEND" });
    expect(spend).not.toContain("answer-a1");
    expect(spend).not.toMatch(/disabled=""[^>]*>app\.inbox\.approve/);
  });
});

describe("yeni anahtarlar 15 dilde", () => {
  it("tüm anahtarlar tüm dillerde mevcut", () => {
    const langs = ["ar", "de", "en", "es-419", "es", "fr", "hi", "id", "it", "ja", "ko", "pl", "pt-BR", "tr", "zh-Hans"];
    for (const l of langs) {
      const m = JSON.parse(readFileSync(new URL(`../messages/${l}.json`, import.meta.url), "utf8")).app.inbox;
      for (const k of ["artifactLabel", "expires", "answerLabel", "claimFailed", "dismiss", "approvalForbidden", "actionRejected"]) expect(m[k], `${l}.${k}`).toBeTruthy();
      expect(m.claimFailed).toContain("{run}");
    }
  });
});

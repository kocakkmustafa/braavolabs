import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
import { PlanCardPanel, PlanMessageBox, startErrorText, costRangeText, type T } from "../components/plan/PlanParts";
import { parsePlanResponse, parseStartResponse, PlanShapeError, type PlanCardView } from "./planCardParse";
import { submitPlan, submitStart, cardNeedsApproval, type PlanDeps, type PlanState } from "./planFlow";

const t: T = (key) => key;
const noop = () => {};
const low: PlanCardView = {
  title: "Haftalık rapor", goal: "Raporu hazırla",
  steps: [
    { title: "Talebi netleştir", tool: "read", needsApproval: false, risk: "low" },
    { title: "Taslak hazırla", tool: "draft", needsApproval: false, risk: "low" },
    { title: "Özetle", tool: "summarize", needsApproval: false, risk: "low" },
  ],
  risk: "low", estimate: { costUsd: { low: 0.012, high: 0.09 }, priced: true },
};
const high: PlanCardView = { ...low, risk: "high", steps: [...low.steps, { title: "E-posta gönder (onay gerekli)", tool: "email", needsApproval: true, risk: "high" }] };
const rawJob = (card: PlanCardView) => ({ intent: "job", planHash: "h1", card: { ...card, sources: [], estimate: { ...card.estimate, durationSec: { low: 1, high: 2 }, isEstimate: true, basis: "b" }, approvals: [], budget: {}, warnings: [] } });
const err = (status: number) => Object.assign(new Error("x"), { status, name: "ApiRequestError" });
const mk = (over: Partial<PlanDeps> = {}): PlanDeps => ({ plan: vi.fn(async () => parsePlanResponse(rawJob(low))), start: vi.fn(async () => ({ runId: "r1" })), newKey: () => "key-12345678", ...over });
const ready = (card = low): PlanState => ({ phase: "ready", message: "m", card, planHash: "h1", idempotencyKey: "key-12345678" });

describe("plan kartı görünümü", () => {
  it("başlık, 3 adım, araçlar, risk, maliyet aralığı, Çalıştır/Vazgeç çizilir", () => {
    const html = renderToStaticMarkup(<PlanCardPanel card={low} t={t} locale="en" busy={false} onStart={noop} onCancel={noop} />);
    for (const s of ["Haftalık rapor", "Talebi netleştir", "Taslak hazırla", "Özetle", "read, draft, summarize", "app.plan.risk.low", "app.plan.run", "app.plan.cancel"]) expect(html).toContain(s);
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).toContain("$0.012");
    expect(html).toContain("$0.09");
  });
  it("fiyatı bilinmeyen modelde uydurma 0 yok", () => {
    const c = { ...low, estimate: { costUsd: { low: null, high: null }, priced: false } };
    expect(costRangeText(c.estimate, "en")).toBeNull();
    expect(renderToStaticMarkup(<PlanCardPanel card={c} t={t} locale="en" busy={false} onStart={noop} onCancel={noop} />)).toContain("app.plan.costUnknown");
  });
  it("DÜZ METİN: HTML/markdown/autolink bağlantı ya da etiket üretmez", () => {
    const evil = { ...low, title: "<img src=x onerror=alert(1)>", goal: "[tıkla](https://evil.test) https://evil.test **kalın**", steps: [{ ...low.steps[0]!, title: "<script>alert(1)</script>" }] };
    const html = renderToStaticMarkup(<PlanCardPanel card={evil} t={t} locale="en" busy={false} onStart={noop} onCancel={noop} />);
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<strong>kalın");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("[tıkla](https://evil.test) https://evil.test **kalın**");
  });
  it("hata kutusu role=alert + yeniden dene; boş durum status", () => {
    const e = renderToStaticMarkup(<PlanMessageBox t={t} kind="alert" body="E" onRetry={noop} />);
    expect(e).toContain('role="alert"'); expect(e).toContain("app.plan.retry");
    expect(renderToStaticMarkup(<PlanMessageBox t={t} kind="status" body="B" />)).toContain('role="status"');
  });
  it("422 mesajı kartta role=alert olarak görünür", () => {
    const html = renderToStaticMarkup(<PlanCardPanel card={high} t={t} locale="en" busy={false} startError="approvalGate" onStart={noop} onCancel={noop} />);
    expect(html).toContain('role="alert"'); expect(html).toContain("app.plan.approvalGate"); expect(html).toContain("app.plan.approvalStep");
    expect(startErrorText(t, "timeout")).toBe("surface.error.timeout");
  });
});

describe("ayrıştırıcı", () => {
  it("chat ve job yanıtı; bozuk şekil FIRLATIR", () => {
    expect(parsePlanResponse({ intent: "chat" })).toEqual({ intent: "chat" });
    const j = parsePlanResponse(rawJob(low)); expect(j.intent === "job" && j.card.steps).toHaveLength(3);
    for (const bad of [null, {}, { intent: "job" }, { intent: "job", planHash: "h", card: { ...low, steps: [] } }]) expect(() => parsePlanResponse(bad)).toThrow(PlanShapeError);
    expect(() => parseStartResponse({})).toThrow(PlanShapeError);
    expect(parseStartResponse({ runId: "r" }).runId).toBe("r");
  });
});

describe("akış", () => {
  it("plan hazır: kart + idempotencyKey; chat → boş durum; boş mesaj → idle", async () => {
    const s = await submitPlan(mk(), "  iş  ", undefined);
    expect(s).toMatchObject({ phase: "ready", message: "iş", planHash: "h1", idempotencyKey: "key-12345678" });
    expect(await submitPlan(mk({ plan: async () => ({ intent: "chat" }) }), "selam", undefined)).toEqual({ phase: "empty", message: "selam" });
    expect(await submitPlan(mk(), "   ", undefined)).toEqual({ phase: "idle" });
  });
  it("plan hatası sessiz yutulmaz; türü sınıflanır (yeniden dene aynı mesajla)", async () => {
    for (const [e, kind] of [[err(403), "forbidden"], [err(504), "timeout"], [err(429), "rateLimit"], [new TypeError("Failed to fetch"), "network"], [new Error("boom"), "generic"]] as const) {
      expect(await submitPlan(mk({ plan: async () => { throw e; } }), "iş", undefined)).toEqual({ phase: "planError", message: "iş", kind });
    }
  });
  it("start başarı: runId döner, gövde planHash+idempotencyKey+workspaceId taşır", async () => {
    const d = mk();
    const s = await submitStart(d, ready(), "w1", 2);
    expect(s).toEqual({ phase: "started", runId: "r1" });
    expect(d.start).toHaveBeenCalledWith({ message: "m", workspaceId: "w1", planHash: "h1", idempotencyKey: "key-12345678" });
  });
  it("tek şirkette workspaceId gönderilmez ve seçim istenmez", async () => {
    const d = mk();
    expect((await submitStart(d, ready(), undefined, 1)).phase).toBe("started");
    expect((d.start as any).mock.calls[0][0].workspaceId).toBeUndefined();
  });
  it("çoklu şirkette workspaceId yoksa API çağrılmaz ve workspaceRequired", async () => {
    const d = mk();
    expect(await submitStart(d, ready(), undefined, 3)).toMatchObject({ phase: "startError", error: "workspaceRequired" });
    expect(d.start).not.toHaveBeenCalled();
  });
  it("422 + onay adımlı kart → approvalGate; onaysız kartta 422 gate sayılmaz", async () => {
    expect(cardNeedsApproval(high)).toBe(true); expect(cardNeedsApproval(low)).toBe(false);
    const d = mk({ start: async () => { throw err(422); } });
    expect(await submitStart(d, ready(high), "w", 2)).toMatchObject({ phase: "startError", error: "approvalGate" });
    expect(await submitStart(d, ready(low), "w", 2)).toMatchObject({ phase: "startError", error: "generic" });
  });
  it("409 planChanged; hata sonrası aynı idempotencyKey ile yeniden denenebilir; starting kilitli", async () => {
    const d = mk({ start: vi.fn().mockRejectedValueOnce(err(409)).mockResolvedValueOnce({ runId: "r2" }) });
    const e = await submitStart(d, ready(), "w", 2);
    expect(e).toMatchObject({ error: "planChanged" });
    expect(await submitStart(d, e, "w", 2)).toEqual({ phase: "started", runId: "r2" });
    expect((d.start as any).mock.calls.map((c: any[]) => c[0].idempotencyKey)).toEqual(["key-12345678", "key-12345678"]);
    const busy: PlanState = { ...(ready() as any), phase: "starting" };
    expect(await submitStart(d, busy, "w", 2)).toBe(busy);
  });
  it("serbest sohbet etkilenmez: plan modülü sohbet/gönderim yolunu içermez, chat yanıtı iş başlatmaz", async () => {
    const d = mk({ plan: async () => ({ intent: "chat" }) });
    await submitPlan(d, "merhaba nasılsın", undefined);
    expect(d.start).not.toHaveBeenCalled();
  });
});

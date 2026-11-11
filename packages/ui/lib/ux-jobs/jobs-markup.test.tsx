import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: any) => <a href={href} {...p}>{children}</a> }));
vi.mock("../api", () => ({ api: { getRun: vi.fn(), listHandoffs: vi.fn(), runReceipt: vi.fn() } }));

import { api } from "../api";
import JobDrawer from "../../components/inbox/JobDrawer";
import { ApprovalGroups, type T } from "../../components/inbox/InboxParts";
import { loadKaput } from "./kaput";
import type { InboxApprovalGroup, InboxRun } from "../inbox";

const t: T = (key, v) => (v ? `${key}${JSON.stringify(v)}` : key);
const noop = () => {};
const run = (over: Partial<InboxRun>): InboxRun => ({
  id: "r1", pipelineId: "p", status: "RUNNING", state: "RUNNING", resultStatus: null, costUsd: 0.42, createdAt: "2026-11-11T09:00:00Z", updatedAt: "2026-11-11T09:00:00Z", bucket: "working",
  pipeline: { id: "p", name: "Rapor", company: { id: "c", name: "Atölye" } }, ...over,
});
const drawer = (r: InboxRun) => renderToStaticMarkup(
  <JobDrawer run={r} token="tok" t={t} locale="tr" rtl={false} busy={false} message={null} onAction={noop} onSteer={async () => true} onClose={noop} />,
);

describe("JobDrawer işaretlemesi", () => {
  it("üç kip sekmesi + ayrıntı düzeyi; Özet açık; başlık ve şirket görünür", () => {
    const html = drawer(run({}));
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    for (const id of ["summary", "output", "kaput"]) expect(html).toContain(`app.jobs.tab.${id}`);
    expect(html).toContain("app.jobs.detail.label");
    expect(html).toContain("Rapor");
    expect(html).toContain("Atölye");
    expect(html).toContain("app.jobs.state.RUNNING");
    expect(html).toMatch(/id="job-tab-summary"[^>]*aria-selected="true"/);
    expect(html).not.toContain('data-testid="job-full"'); // Sade: ham kimlik/durum satırı yok
  });
  it("çalışan işte Duraklat/Durdur/Yönlendir; Sürdür/Yeniden dene yok", () => {
    const html = drawer(run({}));
    for (const a of ["pause", "stop", "steer"]) expect(html).toContain(`app.inbox.action.${a}`);
    for (const a of ["resume", "retry"]) expect(html).not.toContain(`app.inbox.action.${a}`);
  });
  it("başarısız işte yalnız Yeniden dene; bayat kalp atışlı (stuck) işte yalnız Durdur", () => {
    const failed = drawer(run({ state: "FAILED", status: "FAILED", bucket: "done" }));
    expect(failed).toContain("app.inbox.action.retry");
    expect(failed).not.toContain("app.inbox.action.pause");
    const stuck = drawer(run({ bucket: "stuck" }));
    expect(stuck).toContain("app.inbox.action.stop");
    expect(stuck).not.toContain("app.inbox.action.pause");
  });
  it("biten işte doğrulama durumu Özet'te; tam sayfa bağlantısı kodlanmış kimlik taşır", () => {
    const html = drawer(run({ state: "COMPLETED", status: "COMPLETED", bucket: "done", resultStatus: "VERIFIED", id: "r/1" }));
    expect(html).toContain("app.jobs.verified");
    expect(html).toContain('href="/runs/r%2F1"');
  });
  it("başlıksız iş için 'adsız iş' metni", () => {
    expect(drawer(run({ pipeline: null }))).toContain("app.inbox.jobUntitled");
  });
});

describe("onay satırında risk alanı", () => {
  const groups: InboxApprovalGroup[] = [{
    runId: "r1", runTitle: "Rapor",
    approvals: [{ id: "a1", runId: "r1", status: "PENDING", description: "Mesaj gönder", createdAt: "2026-11-11T09:00:00Z", details: { risk: "high" } } as any],
  }];
  const render = (riskLabel?: any) => renderToStaticMarkup(
    <ApprovalGroups groups={groups} busyIds={new Set()} errorByApproval={{}} onDecide={noop} t={t} locale="tr" riskLabel={riskLabel} />,
  );
  it("riskLabel verilmezse eski işaretleme (risk satırı yok)", () => {
    expect(render()).not.toContain("job-risk");
    expect(render(undefined)).toBe(render());
  });
  it("riskLabel null dönerse de satır yok (alan bilinmiyor → uydurma yok)", () => {
    expect(render(() => null)).toBe(render());
  });
  it("riskLabel metin dönerse satır görünür", () => {
    const html = render(() => "Risk: yüksek");
    expect(html).toContain('data-testid="job-risk"');
    expect(html).toContain("Risk: yüksek");
  });
});

describe("loadKaput (yalnız var olan uçlar)", () => {
  beforeEach(() => { vi.mocked(api.getRun).mockReset(); vi.mocked(api.listHandoffs).mockReset(); });
  const raw = { costUsd: 0.5, steps: [{ id: "s1", stepIndex: 0, name: "Topla", status: "COMPLETED", costUsd: 0.1, toolCalls: [{ id: "t1", toolName: "read", status: "COMPLETED" }] }] };
  it("koşu + el değiştirme sayısı birleşir", async () => {
    vi.mocked(api.getRun).mockResolvedValue(raw);
    vi.mocked(api.listHandoffs).mockResolvedValue({ handoffs: [{}, {}] } as any);
    const k = await loadKaput("tok", "r1");
    expect(api.getRun).toHaveBeenCalledWith("tok", "r1");
    expect(api.listHandoffs).toHaveBeenCalledWith("tok", "r1");
    expect(k.steps).toHaveLength(1);
    expect(k.toolCallCount).toBe(1);
    expect(k.totalCostUsd).toBe(0.5);
    expect(k.handoffCount).toBe(2);
  });
  it("el değiştirme ucu düşerse yalnız o alan 'bilgi yok' (null); Kaput yine yüklenir", async () => {
    vi.mocked(api.getRun).mockResolvedValue(raw);
    vi.mocked(api.listHandoffs).mockRejectedValue(new Error("boom"));
    expect((await loadKaput("tok", "r1")).handoffCount).toBeNull();
  });
  it("koşu ucu düşerse hata yayılır (arayüz hata+yeniden dene gösterir; boş sanılmaz)", async () => {
    vi.mocked(api.getRun).mockRejectedValue(new Error("boom"));
    vi.mocked(api.listHandoffs).mockResolvedValue({ handoffs: [] } as any);
    await expect(loadKaput("tok", "r1")).rejects.toThrow("boom");
  });
});

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/** `liveSource` yalnız bu allowlist'teki VAR OLAN api.* uçlarını çağırır (yeni uç yok sözleşmesi). */
const { called, spy } = vi.hoisted(() => {
  const called: string[] = [];
  const spy = (name: string, value: unknown) => (..._args: unknown[]) => { called.push(name); return Promise.resolve(value); };
  return { called, spy };
});
vi.mock("../api", () => ({
  api: {
    listCompanies: spy("listCompanies", [{ id: "c1", name: "Acme" }]),
    listAgents: spy("listAgents", [{ id: "g1" }, { id: "g2" }]),
    listIntegrations: spy("listIntegrations", [{ provider: "gmail" }]),
    inboxRuns: vi.fn((_t: string, bucket: string) => { called.push("inboxRuns"); return Promise.resolve({ runs: [{ id: bucket === "stuck" ? "dup" : `r-${bucket}`, status: "RUNNING", pipelineId: "p", state: null, resultStatus: null, createdAt: "t", updatedAt: "t", bucket }, { id: "dup", status: "RUNNING", pipelineId: "p", state: null, resultStatus: null, createdAt: "t", updatedAt: "t", bucket }], nextCursor: null }); }),
    inboxApprovalGroups: spy("inboxApprovalGroups", { groups: [{ runId: "r", runTitle: "T", approvals: [{ id: "a1", runId: "r", status: "PENDING", createdAt: "t" }] }], nextCursor: null }),
    jobPlan: spy("jobPlan", { intent: "chat" }),
    jobStart: spy("jobStart", { runId: "run-9" }),
    decideApproval: vi.fn(() => { called.push("decideApproval"); return Promise.resolve({ claimFailed: false }); }),
    runAction: spy("runAction", {}),
    getRun: spy("getRun", { costUsd: 1, steps: [{ id: "s", name: "Oku", status: "completed" }] }),
    listHandoffs: spy("listHandoffs", { handoffs: [{ id: "h" }, { id: "h2" }] }),
    composeAgent: spy("composeAgent", { agent: { id: "a", name: "N", role: "R", systemPrompt: "", tools: ["gmail"] }, droppedTools: ["hubspot"], provider: "p", model: "m", tokens: { input: 1, output: 1 } }),
  },
}));

import { liveSource, sampleSource } from "./source";
import { makeGuard, submitPlan, submitStart, type PlanDeps, type PlanState } from "../planFlow";
import { AgentPanel, ChatPanel, IntentBar, PlanPanel } from "../../components/ux-lab/Intent";
import { ApprovalSheet, JobsView } from "../../components/ux-lab/Jobs";
import { CompanyView, ManageView, ModelsPanel } from "../../components/ux-lab/Overview";
import { sampleApprovalGroups, sampleRuns } from "./fixtures";

const deps = (s: ReturnType<typeof sampleSource>): PlanDeps => ({ plan: (m, w) => s.plan(m, w), start: (b) => s.start(b), newKey: () => "k1" });
const noop = () => {};

describe("T2 — iş tarif et → plan kartı → çalıştır (örnek kaynak + planFlow)", () => {
  it("onaysız düşük riskli iş: plan hazır → başlat → koşu 'çalışıyor' kovasına düşer", async () => {
    const s = sampleSource();
    const ready = await submitPlan(deps(s), "Müşteri e-postalarını özetle ve taslak olarak kaydet", undefined);
    expect(ready).toMatchObject({ phase: "ready", card: { risk: "low", estimate: { priced: true } } });
    const before = (await s.runs()).filter((r) => r.bucket === "working").length;
    const done = await submitStart(deps(s), ready, undefined, 1);
    expect(done).toMatchObject({ phase: "started" });
    const after = await s.runs();
    expect(after.filter((r) => r.bucket === "working")).toHaveLength(before + 1);
    expect(after[0].id).toBe((done as { runId: string }).runId);
  });
  it("onay adımlı iş: /jobs/start 422 → 'approvalGate' (sessiz düşmez, Çalıştır engelli kalır)", async () => {
    const s = sampleSource();
    const ready = await submitPlan(deps(s), "Haftalık özeti Slack'e gönder", undefined);
    expect(ready).toMatchObject({ phase: "ready", card: { risk: "high" } });
    const failed = await submitStart(deps(s), ready, undefined, 1);
    expect(failed).toMatchObject({ phase: "startError", error: "approvalGate" });
    // engelli durumda ikinci tıklama kaynağa gitmez
    expect(await submitStart(deps(s), failed, undefined, 1)).toBe(failed);
  });
  it("çoklu şirkette şirket seçilmeden başlatma workspaceRequired döner", async () => {
    const s = sampleSource();
    const ready = await submitPlan(deps(s), "Müşteri e-postalarını özetle ve taslak olarak kaydet", undefined);
    expect(await submitStart(deps(s), ready, undefined, 2)).toMatchObject({ phase: "startError", error: "workspaceRequired" });
  });
});

describe("T3/T4 — devam eden iş ve onay kararı (örnek kaynak)", () => {
  it("onay verilince onay listeden düşer ve koşu çalışıyor kovasına geçer; red → bitti(iptal)", async () => {
    const s = sampleSource();
    expect(await s.decide("a1", "APPROVED")).toEqual({ kind: "ok" });
    expect((await s.approvalGroups()).flatMap((g) => g.approvals).map((a) => a.id)).toEqual(["a2"]);
    expect((await s.runs()).find((r) => r.id === "r3")).toMatchObject({ bucket: "working", state: "RUNNING" });
    expect(await s.decide("a2", "REJECTED")).toEqual({ kind: "ok" });
    expect((await s.runs()).find((r) => r.id === "r4")).toMatchObject({ bucket: "done", state: "CANCELLED" });
    expect(await s.approvalGroups()).toEqual([]);
  });
  it("olmayan/başkasının onayı 'stale' döner (liste yenilenir)", async () => {
    expect(await sampleSource().decide("yok", "APPROVED")).toEqual({ kind: "stale" });
  });
  it("duraklat → takıldı kovası; sürdür → çalışıyor; durdur → bitti", async () => {
    const s = sampleSource();
    await s.runAction("r1", "pause");
    expect((await s.runs()).find((r) => r.id === "r1")).toMatchObject({ bucket: "stuck", state: "PAUSED" });
    await s.runAction("r1", "resume");
    expect((await s.runs()).find((r) => r.id === "r1")).toMatchObject({ bucket: "working" });
    await s.runAction("r1", "stop");
    expect((await s.runs()).find((r) => r.id === "r1")).toMatchObject({ bucket: "done", state: "CANCELLED" });
  });
});

describe("T5/T7 — ajan oluştur ve Kaputu Aç (örnek kaynak)", () => {
  it("droppedTools saklanmaz; Kaput adım + araç çağrısı + maliyet verir", async () => {
    const s = sampleSource();
    expect(await s.composeAgent("c", "x")).toMatchObject({ name: "Satış Özetçisi", droppedTools: ["hubspot"] });
    const k = await s.kaput("r1");
    expect(k.steps).toHaveLength(3);
    expect(k.toolCallCount).toBe(2);
    expect(k.totalCostUsd).toBe(0.42);
    expect((await s.kaput("r5")).steps).toEqual([]);
  });
});

describe("canlı kaynak: yalnız VAR OLAN api uçları, doğru eşleme", () => {
  it("runs 4 kovadan toplanır ve kimliğe göre tekilleşir; companies ajan/entegrasyon sayısı taşır", async () => {
    called.length = 0;
    const s = liveSource("tok");
    const runs = await s.runs();
    expect(runs.map((r) => r.id).sort()).toEqual(["dup", "r-done", "r-needs_approval", "r-working"]);
    expect(await s.companies()).toEqual([{ id: "c1", name: "Acme", agents: 2, integrations: ["gmail"] }]);
    expect((await s.approvalGroups())[0].approvals[0].id).toBe("a1");
    expect(await s.plan("m")).toEqual({ intent: "chat" });
    expect(await s.start({ message: "m", planHash: "h", idempotencyKey: "k" })).toEqual({ runId: "run-9" });
    expect(await s.decide("a1", "APPROVED", "tamam")).toEqual({ kind: "ok" });
    await s.runAction("r", "pause");
    expect(await s.kaput("r")).toMatchObject({ handoffCount: 2, totalCostUsd: 1 });
    expect(await s.composeAgent("c1", "yeni ajan açıklaması")).toEqual({ name: "N", role: "R", tools: ["gmail"], droppedTools: ["hubspot"] });
    const ALLOWED = ["listCompanies", "listAgents", "listIntegrations", "inboxRuns", "inboxApprovalGroups", "jobPlan", "jobStart", "decideApproval", "runAction", "getRun", "listHandoffs", "composeAgent"];
    expect(new Set(called)).toEqual(new Set(ALLOWED));
  });
  it("decide: 403 → forbidden, 409 → stale (mevcut decideResult)", async () => {
    const { api } = await import("../api");
    (api.decideApproval as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error("x"), { status: 403 }));
    expect(await liveSource("t").decide("a", "APPROVED")).toEqual({ kind: "forbidden" });
    (api.decideApproval as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error("x"), { status: 409 }));
    expect(await liveSource("t").decide("a", "REJECTED")).toEqual({ kind: "stale" });
  });
});

describe("arayüz işaretlemesi", () => {
  it("T1: Niyet Çubuğu üç niyet seçeneği ve 'Sohbet başlat' varsayılan düğmesi sunar", () => {
    const html = renderToStaticMarkup(<IntentBar busy={false} onSubmit={noop} />);
    expect(html).toContain("Ne yapmak istiyorsun?");
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html).toMatch(/aria-checked="true"[^>]*>Sohbet</);
    expect(html).toContain("Sohbet başlat");
    expect(html).toContain("Niyet sınıflayıcı: API ister");
  });
  it("T1: sohbet paneli iş kaydı oluşmadığını ve ÖRNEK olduğunu söyler", () => {
    const html = renderToStaticMarkup(<ChatPanel text="Merhaba" />);
    expect(html).toContain("İş kaydı oluşturulmadı");
    expect(html).toContain("ÖRNEK yanıt");
  });
  it("T2: plan kartı risk, tahmini maliyet aralığı ve onay adımını açıkça yazar; kapı hatasında Çalıştır engelli + gerekçe", () => {
    const base: PlanState = { phase: "ready", message: "m", planHash: "h", idempotencyKey: "k", card: {
      title: "T", goal: "G", risk: "high", steps: [{ title: "Slack'e gönder", tool: "slack.post", needsApproval: true, risk: "high" }], estimate: { costUsd: { low: 0.03, high: 0.08 }, priced: true } } };
    const ok = renderToStaticMarkup(<PlanPanel state={base} companies={[]} workspaceId="" onWorkspace={noop} onStart={noop} onCancel={noop} onReplan={noop} />);
    expect(ok).toContain("onay gerekli, yüksek risk");
    expect(ok).toMatch(/Tahmini maliyet:<\/strong> \$0,03/);
    expect(ok).not.toMatch(/disabled=""[^>]*>Çalıştır/);
    const blocked = renderToStaticMarkup(<PlanPanel state={{ ...base, phase: "startError", error: "approvalGate" } as PlanState} companies={[]} workspaceId="" onWorkspace={noop} onStart={noop} onCancel={noop} onReplan={noop} />);
    expect(blocked).toContain("otomatik başlatılamaz");
    expect(blocked).toMatch(/disabled=""[^>]*>Çalıştır/);
  });
  it("T2: fiyatı bilinmeyen plan 'ücretsiz' gibi okunmaz", () => {
    const st: PlanState = { phase: "ready", message: "m", planHash: "h", idempotencyKey: "k", card: { title: "T", goal: "G", risk: "low", steps: [], estimate: { costUsd: { low: null, high: null }, priced: false } } };
    expect(renderToStaticMarkup(<PlanPanel state={st} companies={[]} workspaceId="" onWorkspace={noop} onStart={noop} onCancel={noop} onReplan={noop} />)).toContain("fiyat bilinmiyor");
  });
  it("T3: İşler görünümü kova sayılarını ve onayı en üstte gösterir; boşken yönlendirir", () => {
    const html = renderToStaticMarkup(<JobsView runs={sampleRuns()} groups={sampleApprovalGroups()} onOpenRun={noop} onReview={noop} onGoIntent={noop} />);
    expect(html).toContain("Onay 2 · Çalışıyor 2 · Takıldı 1 · Bitti 2");
    expect(html.indexOf("Onayını bekliyor")).toBeLessThan(html.indexOf("Çalışıyor ("));
    expect(html).toContain("✔ doğrulandı");
    expect(html).toContain("Toplu onay kapalı");
    expect(renderToStaticMarkup(<JobsView runs={[]} groups={[]} onOpenRun={noop} onReview={noop} onGoIntent={noop} />)).toContain("Henüz iş yok");
  });
  it("sayfalama: 25 kayıt sınırına ulaşan liste 'ilk 25' notunu gösterir, altındayken göstermez", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ ...sampleRuns()[0], id: `w${i}` }));
    expect(renderToStaticMarkup(<JobsView runs={many} groups={[]} onOpenRun={noop} onReview={noop} onGoIntent={noop} />)).toContain("ilk 25 kayıtla sınırlı");
    expect(renderToStaticMarkup(<JobsView runs={sampleRuns()} groups={sampleApprovalGroups()} onOpenRun={noop} onReview={noop} onGoIntent={noop} />)).not.toContain("ilk 25 kayıtla sınırlı");
  });
  it("örnek Kaput'ta el değiştirme sayısı uydurulmaz (null)", async () => {
    expect((await sampleSource().kaput("r1")).handoffCount).toBeNull();
  });
  it("T4: onay sayfası ne yapacak/araç/yetki/veri/tutar alanlarını gösterir, eksikleri 'bilgi yok' der; tehlikeli olan ikinci adım ister", () => {
    const [g1, g2] = sampleApprovalGroups();
    const medium = renderToStaticMarkup(<ApprovalSheet approval={g1.approvals[0]} title={g1.runTitle} offline={false} onDecide={async () => ({ kind: "ok" })} onClose={noop} />);
    expect(medium).toContain("slack.post");
    expect(medium).toContain("slack:write");
    expect(medium).toContain("Bu hafta 14 e-posta özetlendi");
    expect(medium).toMatch(/data-fact="reversible"[^>]*>.*bilgi yok/);
    expect(medium).toContain('data-dangerous="false"');
    expect(medium).toMatch(/>Onayla<\/button>/);
    const danger = renderToStaticMarkup(<ApprovalSheet approval={g2.approvals[0]} title={g2.runTitle} offline={false} onDecide={async () => ({ kind: "ok" })} onClose={noop} />);
    expect(danger).toContain('data-dangerous="true"');
    expect(danger).toContain("ikinci bir adım");
    expect(danger).toMatch(/>Onayla…<\/button>/);
  });
  it("T4: çevrimdışıyken Onayla/Reddet kapalı", () => {
    const a = sampleApprovalGroups()[0].approvals[0];
    const html = renderToStaticMarkup(<ApprovalSheet approval={a} title={null} offline onDecide={async () => ({ kind: "ok" })} onClose={noop} />);
    expect(html).toContain("Onayla/Reddet kapalı");
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
  });
  it("T5: çıkarılan araç uyarısı görünür (saklanmaz)", () => {
    const html = renderToStaticMarkup(<AgentPanel mode="sample" state={{ phase: "done", description: "d", result: { name: "Satış Özetçisi", role: "analist", tools: ["gmail"], droppedTools: ["hubspot"] } }} onRetry={noop} />);
    expect(html).toContain("Çıkarılan araç (1)");
    expect(html).toContain("hubspot");
    expect(html).toContain("kayıt yapılmadı");
    expect(renderToStaticMarkup(<AgentPanel mode="live" state={{ phase: "done", description: "d", result: { name: "N", role: "r", tools: [], droppedTools: [] } }} onRetry={noop} />)).toContain("Ajan kaydedildi");
  });
  it("T6: şirket durumu tek satır özet verir; yönetici/ekip sayısı için API ister der", () => {
    const html = renderToStaticMarkup(<CompanyView companies={[{ id: "sample-company", name: "Atölye", agents: 1, integrations: ["gmail", "slack"] }]} runs={sampleRuns()} groups={sampleApprovalGroups()} />);
    expect(html).toContain("2 onay · 1 takıldı");
    expect(html).toContain("Çalışan 2 · Bitti 2");
    expect(html).toContain("gmail ✓");
    expect(html).toContain("Ekip üyeleri ve yönetici sayısı: API ister");
    expect(html).toContain("en yüksek: yüksek");
  });
  it("T8: model ekranı maliyet verisi yokken 'veri yok' der, uydurmaz", () => {
    const html = renderToStaticMarkup(<ModelsPanel />);
    expect(html).toContain("veri yok");
    expect(html).toContain("API ister");
    expect(html).not.toMatch(/\$\d/);
  });
  it("T9: Yönet çekmecesi eski rotalara bağlanır (kaybolan işlev yok)", () => {
    const html = renderToStaticMarkup(<ManageView />);
    for (const href of ["/companies", "/integrations", "/webhooks", "/billing", "/risks", "/analytics", "/ab-tests", "/settings"]) expect(html).toContain(`href="${href}"`);
  });
});

describe("yarış koruması", () => {
  it("makeGuard eski yanıtı geçersiz kılar", () => {
    const g = makeGuard();
    const a = g.next(); const b = g.next();
    expect(g.isCurrent(a)).toBe(false);
    expect(g.isCurrent(b)).toBe(true);
  });
});

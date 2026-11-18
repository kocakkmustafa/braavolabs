"use client";
/** BRA-UX-04 — Şirket durumu (E10, tek satır özet), Yönet çekmecesi (E12) ve Modeller/erişim (E11). */
import { useState } from "react";
import type { InboxRun } from "../../lib/inbox";
import { companyLine, groupsForRuns, usd, type LabApprovalGroup } from "../../lib/ux-lab/facts";
import type { LabCompany } from "../../lib/ux-lab/source";
import { Missing, NeedsApi, btn, flat, glass, muted } from "./ui";

const RISK_LABEL: Record<string, string> = { low: "düşük", medium: "orta", high: "yüksek" };
const RISK_DESC = ["high", "medium", "low"] as const;
const linkBtn = { ...btn, display: "flex", alignItems: "center", textDecoration: "none" } as const;
const summaryStyle = { minHeight: 44, cursor: "pointer", display: "flex", alignItems: "center" } as const;

export function CompanyView({ companies, runs, groups }: { companies: LabCompany[]; runs: InboxRun[]; groups: LabApprovalGroup[] }) {
  const [id, setId] = useState(companies[0]?.id ?? "");
  const company = companies.find((c) => c.id === id) ?? companies[0];
  if (!company) return <div role="status" style={flat}>Henüz şirket yok. <a href="/companies/new" style={{ textDecoration: "underline" }}>Şirket oluştur</a></div>;
  const myRuns = runs.filter((r) => !r.pipeline?.company?.id || r.pipeline.company.id === company.id);
  const myGroups = groupsForRuns(groups, myRuns);
  const line = companyLine(myGroups, myRuns);
  const risks = myGroups.flatMap((g) => g.approvals).map((a) => a.details?.risk).filter((r): r is NonNullable<typeof r> => !!r);
  const topRisk = RISK_DESC.find((r) => risks.includes(r));
  return (
    <div style={{ display: "grid", gap: 12 }} data-testid="uxl-company">
      <div className="uxl-row" style={{ ...glass, padding: 12 }}>
        {companies.length > 1
          ? <select aria-label="Şirket" value={company.id} onChange={(e) => setId(e.target.value)} style={{ minHeight: 44 }}>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          : <strong>{company.name}</strong>}
        <span data-testid="uxl-company-line">{line.approvals} onay · {line.stuck} takıldı</span>
      </div>
      <div style={flat} data-testid="uxl-company-summary">
        Çalışan {line.running} · Bitti {line.done} · Harcama {usd(line.listedCostUsd)} <span style={muted}>(yalnız listelenen işler; haftalık toplam alanı yok)</span>
      </div>
      <details style={flat} open><summary style={summaryStyle}>Ajanlar</summary>{company.agents === null ? <Missing /> : `${company.agents} ajan`}</details>
      <details style={flat}><summary style={summaryStyle}>Ekip</summary><NeedsApi what="Ekip üyeleri ve yönetici sayısı" /></details>
      <details style={flat}><summary style={summaryStyle}>Risk</summary>{topRisk ? `${risks.length} açık onay · en yüksek: ${RISK_LABEL[topRisk]}` : line.approvals === 0 ? "Açık risk yok." : <Missing />}</details>
      <details style={flat}><summary style={summaryStyle}>Entegrasyon</summary>{company.integrations === null ? <Missing /> : company.integrations.length ? company.integrations.map((i) => `${i} ✓`).join("  ") : "Bağlı entegrasyon yok."}</details>
      <div><a href="/runs" style={{ ...linkBtn, display: "inline-flex" }}>Geçmiş ▸</a></div>
    </div>
  );
}

const MANAGE: ReadonlyArray<[string, string]> = [
  ["Ajanlar", "/companies"], ["Entegrasyonlar", "/integrations"], ["Webhook", "/webhooks"], ["Faturalama", "/billing"],
  ["Riskler", "/risks"], ["Analitik", "/analytics"], ["A/B testleri", "/ab-tests"], ["Ayarlar", "/settings"],
];

export function ManageView() {
  const [models, setModels] = useState(false);
  return (
    <div style={{ display: "grid", gap: 12 }} data-testid="uxl-manage">
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
        <li><button type="button" style={{ ...btn, width: "100%", textAlign: "start" }} aria-expanded={models} onClick={() => setModels((v) => !v)}>Modeller ve bağlantılar ›</button></li>
        {MANAGE.map(([label, href]) => <li key={href}><a href={href} style={linkBtn}>{label} ›</a></li>)}
      </ul>
      <div style={muted}>Eski rotalar korunur; çekmece yalnız gruplar. Ara… için Cmd+K.</div>
      {models && <ModelsPanel />}
    </div>
  );
}

/** E11: model maliyeti ve erişim yetkisi. Model başına maliyet toplamı için API YOK (§5.8): "veri yok" der, uydurmaz. */
export function ModelsPanel() {
  return (
    <section style={{ ...glass, display: "grid", gap: 8 }} aria-label="Modeller ve bağlantılar" data-testid="uxl-models">
      <h2 style={{ margin: 0, fontSize: 16 }}>Modeller ve bağlantılar</h2>
      <div>Model seçimi ve sağlayıcı: <NeedsApi what="model + yönlendirme dökümü (BRA-UX-API-02)" /></div>
      <div>Maliyet (bu ay, model başına): <strong>veri yok</strong> <span style={muted}>(model başına maliyet API'si yok; iş başına toplam Kaput'ta)</span></div>
      <div>Erişim yetkisi: <NeedsApi what="yetki dökümü" /></div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <a href="/connections" style={{ ...linkBtn, display: "inline-flex" }}>Bağlantılar (kendi anahtarım, yerel model)</a>
        <a href="/compare" style={{ ...linkBtn, display: "inline-flex" }}>Karşılaştır ▸</a>
      </div>
    </section>
  );
}

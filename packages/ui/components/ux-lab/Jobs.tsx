"use client";
/** BRA-UX-04 — İşler omurgası: kovalar (E5), devam eden iş çekmecesi + kip morfu Özet/Çıktı/Kaput (E6/E7), onay anlama (E8). */
import { useEffect, useRef, useState } from "react";
import { allowedActions, effectiveState, type InboxRun } from "../../lib/inbox";
import type { DecisionResult } from "../../lib/inboxActions";
import {
  BATCH_APPROVE_ENABLED, CONFIRM_PHRASE, approvalFacts, approvalIsDangerous, confirmOk, groupRuns, usd,
  type FactKey, type Kaput, type LabApproval, type LabApprovalGroup,
} from "../../lib/ux-lab/facts";
import type { LabRunAction, LabSource } from "../../lib/ux-lab/source";
import { Alert, Missing, NeedsApi, Section, btn, btnDanger, btnPrimary, flat, glass, muted } from "./ui";

const STATE_LABEL: Record<string, string> = {
  DRAFT: "taslak", PLANNED: "planlandı", READY: "hazır", RUNNING: "çalışıyor", NEEDS_APPROVAL: "onay bekliyor", RESUMING: "sürdürülüyor",
  PAUSED: "duraklatıldı", FAILED: "başarısız", CANCELLED: "iptal edildi", COMPLETED: "bitti",
};
const RISK_LABEL: Record<string, string> = { low: "düşük", medium: "orta", high: "yüksek" };
const stateText = (r: InboxRun) => STATE_LABEL[effectiveState(r) ?? ""] ?? "bilinmiyor";
const cost = (v: unknown) => { const n = typeof v === "number" ? v : Number(v); return Number.isFinite(n) ? usd(n) : "—"; };
const runTitle = (r: InboxRun) => r.pipeline?.name ?? r.id;

export function JobsView({ runs, groups, onOpenRun, onReview, onGoIntent }: {
  runs: InboxRun[]; groups: LabApprovalGroup[]; onOpenRun: (id: string) => void; onReview: (a: LabApproval, runTitle: string | null) => void; onGoIntent: () => void;
}) {
  const m = groupRuns(runs);
  const pending = groups.reduce((n, g) => n + g.approvals.length, 0);
  if (runs.length === 0 && pending === 0) {
    return <div role="status" style={flat}>Henüz iş yok. Tarif et, ben planlayayım. <button type="button" style={{ ...btn, marginInlineStart: 8 }} onClick={onGoIntent}>Niyet çubuğuna git</button></div>;
  }
  const row = (r: InboxRun) => (
    <li key={r.id} style={{ ...flat }} className="uxl-row" data-testid="uxl-run" data-bucket={r.bucket ?? ""}>
      <button type="button" className="uxl-link" onClick={() => onOpenRun(r.id)} aria-label={`${runTitle(r)} işini aç`}>
        <strong>{runTitle(r)}</strong><br /><span style={muted}>{r.pipeline?.company?.name ?? "—"} · {stateText(r)} · {cost(r.costUsd)}</span>
      </button>
      {r.bucket === "done" && <span style={muted}>{r.resultStatus === "VERIFIED" ? "✔ doğrulandı" : r.resultStatus === "UNVERIFIED" ? "doğrulanmadı" : ""}</span>}
    </li>
  );
  const list = (title: string, items: InboxRun[], note?: string) => (
    <Section title={`${title} (${items.length})`}>
      {items.length === 0 ? <span style={muted}>Bu kovada iş yok.</span> : <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>{items.map(row)}</ul>}
      {note && <span style={muted}>{note}</span>}
    </Section>
  );
  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div style={muted} data-testid="uxl-counts">Onay {pending} · Çalışıyor {m.working.length} · Takıldı {m.stuck.length} · Bitti {m.done.length}</div>
      <Section title={`▲ Onayını bekliyor (${pending})`} aside={<span style={muted}>Toplu onay kapalı: {BATCH_APPROVE_ENABLED ? "açık" : "her onay tek tek"}</span>}>
        {pending === 0 ? <span style={muted}>Bekleyen onay yok.</span> : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
            {groups.flatMap((g) => g.approvals.map((a) => (
              <li key={a.id} style={{ ...glass, padding: 12 }} className="uxl-row" data-testid="uxl-approval">
                <div><strong>{a.description ?? "Onay"}</strong><br />
                  <span style={muted}>{g.runTitle ?? g.runId} · risk: {a.details?.risk ? RISK_LABEL[a.details.risk] : <Missing />}</span></div>
                <button type="button" style={btnPrimary} onClick={() => onReview(a, g.runTitle)}>İncele</button>
              </li>
            )))}
          </ul>
        )}
      </Section>
      {list("● Çalışıyor", m.working)}
      {list("Takıldı", m.stuck, "Kalp atışı bayrağı kapalıyken bazı takılmalar henüz görünmüyor.")}
      {list("Bitti", m.done)}
    </div>
  );
}

type Tab = "summary" | "output" | "kaput";
const TABS: ReadonlyArray<[Tab, string]> = [["summary", "Özet"], ["output", "Çıktı"], ["kaput", "Kaput"]];
type KaputLoad = { status: "idle" } | { status: "loading" } | { status: "error" } | { status: "ready"; kaput: Kaput };

/** Kip morfu: aynı iş, üç derinlik (Özet → Çıktı → Kaput). Sade/Tam aynı değerleri gösterir, yalnız ayrıntı düzeyi değişir (T7). */
export function JobDrawer({ run, source, offline, onClose, onChanged }: {
  run: InboxRun; source: LabSource; offline: boolean; onClose: () => void; onChanged: () => void;
}) {
  const [tab, setTab] = useState<Tab>("summary");
  const [full, setFull] = useState(false);
  const [load, setLoad] = useState<KaputLoad>({ status: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [run.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const loadKaput = () => {
    setLoad({ status: "loading" });
    source.kaput(run.id).then((kaput) => setLoad({ status: "ready", kaput }), () => setLoad({ status: "error" }));
  };
  useEffect(() => { if (tab === "kaput" && load.status === "idle") loadKaput(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tab]);
  useEffect(() => { setLoad({ status: "idle" }); setTab("summary"); setError(null); }, [run.id]);

  const actions = allowedActions(run).filter((a): a is LabRunAction => a === "pause" || a === "resume" || a === "stop");
  const ACTION_LABEL: Record<LabRunAction, string> = { pause: "Duraklat", resume: "Sürdür", stop: "Durdur" };
  const act = async (a: LabRunAction) => {
    setBusy(true); setError(null);
    try { await source.runAction(run.id, a); onChanged(); } catch { setError("İşlem yapılamadı: sunucu reddetti ya da ulaşılamadı."); } finally { setBusy(false); }
  };

  return (
    <aside className="uxl-drawer" style={{ ...glass, display: "grid", gap: 12 }} aria-label={`İş: ${runTitle(run)}`} data-testid="uxl-drawer">
      <div className="uxl-row">
        <h2 ref={heading} tabIndex={-1} style={{ margin: 0, fontSize: 17 }}>{runTitle(run)}</h2>
        <button type="button" style={btn} onClick={onClose} aria-label="Çekmeceyi kapat">✕</button>
      </div>
      <div role="tablist" aria-label="İş kipi" style={{ display: "flex", gap: 6 }}>
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" id={`uxl-tab-${id}`} aria-selected={tab === id} aria-controls="uxl-tabpanel" onClick={() => setTab(id)}
            style={{ ...btn, ...(tab === id ? { background: "var(--color-primary)", color: "var(--color-on-primary)", borderColor: "transparent" } : {}) }}>{label}</button>
        ))}
        <label style={{ ...muted, marginInlineStart: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          Ayrıntı: <select value={full ? "full" : "simple"} onChange={(e) => setFull(e.target.value === "full")} style={{ minHeight: 44 }} aria-label="Ayrıntı düzeyi">
            <option value="simple">Sade</option><option value="full">Tam</option>
          </select>
        </label>
      </div>
      <div role="tabpanel" id="uxl-tabpanel" aria-labelledby={`uxl-tab-${tab}`} style={{ display: "grid", gap: 8 }}>
        {tab === "summary" && (
          <>
            <div><strong>Durum:</strong> {stateText(run)} · <strong>Maliyet:</strong> {cost(run.costUsd)} · <strong>Şirket:</strong> {run.pipeline?.company?.name ?? "—"}</div>
            {run.bucket === "done" && <div>{run.resultStatus === "VERIFIED" ? "✔ Sonuç doğrulandı" : run.resultStatus === "UNVERIFIED" ? "Sonuç doğrulanmadı" : "Doğrulama bilgisi yok"}</div>}
            {full && <div style={muted} data-testid="uxl-full">kimlik: {run.id} · durum: {run.state ?? "—"} / {run.status} · güncellendi: {run.updatedAt}</div>}
          </>
        )}
        {tab === "output" && (
          <>
            <div>{run.resultStatus === "VERIFIED" ? "✔ Doğrulandı" : run.resultStatus === "UNVERIFIED" ? "Doğrulanmadı (kanıt yok ya da başarısız)" : "Bu iş henüz bir sonuç üretmedi."}</div>
            <NeedsApi what="Çıktı gövdesi ve diff/test alanı" />
          </>
        )}
        {tab === "kaput" && <KaputPanel load={load} full={full} onRetry={loadKaput} />}
      </div>
      {error && <Alert>{error}</Alert>}
      {actions.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {actions.map((a) => <button key={a} type="button" style={a === "stop" ? btnDanger : btn} disabled={busy || offline} onClick={() => void act(a)}>{ACTION_LABEL[a]}</button>)}
          {offline && <span style={muted}>Çevrimdışı: eylemler kapalı.</span>}
        </div>
      )}
    </aside>
  );
}

function KaputPanel({ load, full, onRetry }: { load: KaputLoad; full: boolean; onRetry: () => void }) {
  if (load.status === "loading" || load.status === "idle") return <div role="status" aria-busy="true" style={muted}>Kaput yükleniyor…</div>;
  if (load.status === "error") return <Alert onRetry={onRetry}>Kaput okunamadı.</Alert>;
  const k = load.kaput;
  return (
    <div style={{ display: "grid", gap: 8 }} data-testid="uxl-kaput">
      <div><strong>Adımlar ({k.steps.length})</strong> · <strong>Araç çağrısı:</strong> {k.toolCallCount} · <strong>Maliyet:</strong> {k.totalCostUsd === null ? "—" : usd(k.totalCostUsd)} · <strong>El değiştirme:</strong> {k.handoffCount === null ? "bilgi yok" : k.handoffCount}</div>
      {k.steps.length === 0 ? <span style={muted}>Bu işte henüz adım kaydı yok.</span> : (
        <ol style={{ margin: 0, paddingInlineStart: 20, display: "grid", gap: 6 }}>
          {k.steps.map((s) => (
            <li key={s.id}>{s.name} <span style={muted}>· {s.status}{full && s.costUsd !== null ? ` · ${usd(s.costUsd)}` : ""}</span>
              {full && s.toolCalls.length > 0 && (
                <ul style={{ margin: "4px 0 0", paddingInlineStart: 16 }}>
                  {s.toolCalls.map((c) => <li key={c.id} style={muted}>{c.toolName} · {c.status}{c.durationMs !== null ? ` · ${c.durationMs} ms` : ""}{c.error ? ` · hata: ${c.error}` : ""}</li>)}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
      <NeedsApi what="Model, yönlendirme kararı ve yetki dökümü (sonraki sürüm, BRA-UX-API-02)" />
    </div>
  );
}

const FACT_LABEL: Record<FactKey, string> = {
  what: "Ne yapacak", tool: "Araç", permissions: "Yetki", data: "Aktarılan veri", amount: "Tutar", reversible: "Geri alma", risk: "Risk", draft: "Taslak",
};
export const DECISION_TEXT: Partial<Record<DecisionResult["kind"], string>> = {
  forbidden: "Bu işlem için yetkin yok (approval:decide). Yöneticine başvur.",
  stale: "Bu onay değişti ya da başkası karar verdi; liste yenilendi.",
  error: "Karar kaydedilemedi. Yeniden dene.",
  claimFailed: "Karar kaydedildi ama koşu devralınamadı; iş başarısız kalabilir.",
};

/** E8: onay anlama. Kaynak alan yoksa "bilgi yok"; tehlikeli onay ikinci adım ister; toplu onay yok. */
export function ApprovalSheet({ approval, title, offline, onDecide, onClose }: {
  approval: LabApproval; title: string | null; offline: boolean;
  onDecide: (decision: "APPROVED" | "REJECTED", note?: string) => Promise<DecisionResult>; onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [approval.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const dangerous = approvalIsDangerous(approval);
  const decide = async (d: "APPROVED" | "REJECTED") => {
    if (busy || offline) return;
    setBusy(true); setMessage(null);
    const res = await onDecide(d, d === "APPROVED" && dangerous ? reason.trim() : undefined);
    setBusy(false);
    if (res.kind === "ok") return;
    setMessage(DECISION_TEXT[res.kind] ?? null);
  };
  const renderValue = (key: FactKey, value: string | null) => {
    if (value === null) return key === "risk" ? <><Missing /> <span style={muted}>(risk yalnız adım kapısında dolar)</span></> : <Missing />;
    if (key === "reversible") return value === "yes" ? "Geri alınabilir" : "Geri alınamaz";
    if (key === "risk") return RISK_LABEL[value] ?? value;
    if (key === "draft") return <span style={{ whiteSpace: "pre-wrap" }}>{value}</span>;
    return value;
  };
  const facts = approvalFacts(approval);

  return (
    <section className="uxl-sheet" style={{ ...glass, display: "grid", gap: 12 }} role="dialog" aria-modal="false" aria-label="Onay ayrıntısı" data-testid="uxl-sheet" data-dangerous={dangerous}>
      <div className="uxl-row">
        <h2 ref={heading} tabIndex={-1} style={{ margin: 0, fontSize: 17 }}>ONAY: {approval.description ?? "İşlem"}</h2>
        <button type="button" style={btn} onClick={onClose} aria-label="Kapat">✕</button>
      </div>
      {title && <div style={muted}>İş: {title}</div>}
      <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "max-content 1fr", gap: "6px 12px" }}>
        {facts.filter((f) => f.key !== "what").map((f) => (
          <div key={f.key} style={{ display: "contents" }} data-fact={f.key}><dt style={{ fontWeight: 700 }}>{FACT_LABEL[f.key]}</dt><dd style={{ margin: 0 }}>{renderValue(f.key, f.value)}</dd></div>
        ))}
      </dl>
      {dangerous && !confirming && <div role="note" style={{ ...flat, borderColor: "var(--color-error)" }}>Bu işlem para içeriyor ya da yüksek riskli: onaylamak için ikinci bir adım gerekir.</div>}
      {dangerous && confirming && (
        <div style={{ display: "grid", gap: 8 }} data-testid="uxl-confirm">
          <label style={{ display: "grid", gap: 4 }}><span>Onaylamak için “{CONFIRM_PHRASE}” yaz</span>
            <input value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" style={{ minHeight: 44, padding: 8 }} /></label>
          <label style={{ display: "grid", gap: 4 }}><span>Sebep (zorunlu)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" style={{ minHeight: 44, padding: 8 }} /></label>
        </div>
      )}
      {message && <Alert>{message}</Alert>}
      {offline && <div role="status" style={muted}>Çevrimdışısın: Onayla/Reddet kapalı.</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <button type="button" style={btnDanger} disabled={busy || offline} onClick={() => void decide("REJECTED")}>Reddet</button>
        {dangerous && !confirming
          ? <button type="button" style={btnPrimary} disabled={busy || offline} onClick={() => setConfirming(true)}>Onayla…</button>
          : <button type="button" style={{ ...btnPrimary, opacity: dangerous && !confirmOk({ phrase, reason }) ? 0.6 : 1 }} disabled={busy || offline || (dangerous && !confirmOk({ phrase, reason }))} onClick={() => void decide("APPROVED")}>Onayla</button>}
      </div>
    </section>
  );
}

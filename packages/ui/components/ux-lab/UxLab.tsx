"use client";
/**
 * BRA-UX-04 — etkileşimli prototip kabuğu (ADR-0004: İşler omurga + Niyet Çubuğu + kip morfu).
 * Bayrak arkasında (`/lab/ux`); mevcut ekranlara dokunmaz. Oturum varsa VAR OLAN API'ler (canlı), yoksa ÖRNEK veri.
 * Plan akışı mevcut `planFlow` durum makinesini yeniden kullanır (sessiz yutma yok: her hata görünür bir türe düşer).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../../lib/store";
import { makeGuard, needsWorkspaceChoice, submitPlan, submitStart, workspaceForRequest, type PlanDeps, type PlanState } from "../../lib/planFlow";
import type { InboxRun } from "../../lib/inbox";
import { expectedFromYou, type LabApproval, type LabApprovalGroup } from "../../lib/ux-lab/facts";
import { liveSource, sampleSource, type LabCompany, type LabSource } from "../../lib/ux-lab/source";
import { AgentPanel, ChatPanel, IntentBar, PlanPanel, type AgentState } from "./Intent";
import { ApprovalSheet, DECISION_TEXT, JobDrawer, JobsView } from "./Jobs";
import { CompanyView, ManageView } from "./Overview";
import { Alert, LAB_CSS, ModeBadge, Section, btn, flat, muted } from "./ui";

type View = "start" | "jobs" | "company" | "manage";
type Data = { status: "loading" } | { status: "error" } | { status: "ready"; companies: LabCompany[]; runs: InboxRun[]; groups: LabApprovalGroup[] };
type Active = { kind: "chat"; text: string } | { kind: "plan" } | { kind: "agent"; description: string } | null;

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`);
const VIEWS: ReadonlyArray<[View, string]> = [["start", "Başla"], ["jobs", "İşler"], ["company", "Şirket"], ["manage", "Yönet"]];

export default function UxLab({ forceSample }: { forceSample: boolean }) {
  const token = useAppStore((s) => s.token);
  const hydrated = useAppStore((s) => s._hydrated);
  const live = !forceSample && !!token;
  const source = useMemo(() => (live ? liveSource(token!) : sampleSource()), [live, token]);
  if (!hydrated) return <main className="uxl-root" aria-busy="true"><style>{LAB_CSS}</style></main>;
  return <Lab key={live ? "live" : "sample"} source={source} />;
}

function Lab({ source }: { source: LabSource }) {
  const [view, setView] = useState<View>("start");
  const [data, setData] = useState<Data>({ status: "loading" });
  const [active, setActive] = useState<Active>(null);
  const [planState, setPlanState] = useState<PlanState>({ phase: "idle" });
  const [agentState, setAgentState] = useState<AgentState>({ phase: "idle" });
  const [workspaceId, setWorkspaceId] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<{ approval: LabApproval; title: string | null } | null>(null);
  const [online, setOnline] = useState(true);
  const seq = useRef(makeGuard());

  useEffect(() => {
    setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    const on = () => setOnline(true); const off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setData({ status: "loading" });
    try {
      const [companies, runs, groups] = await Promise.all([source.companies(), source.runs(), source.approvalGroups()]);
      setData({ status: "ready", companies, runs, groups });
    } catch { setData((d) => (silent && d.status === "ready" ? d : { status: "error" })); }
  }, [source]);
  useEffect(() => { void refresh(); }, [refresh]);

  const ready = data.status === "ready" ? data : null;
  const companies = ready?.companies ?? [];
  const multi = needsWorkspaceChoice(companies.length);
  const ws = workspaceForRequest(multi, workspaceId);
  const deps: PlanDeps = useMemo(() => ({ plan: (m, w) => source.plan(m, w), start: (b) => source.start(b), newKey }), [source]);

  const runCompose = async (description: string) => {
    const companyId = multi ? workspaceId : companies[0]?.id;
    if (!companyId) { setNotice(companies.length ? "Önce bir şirket seç." : "Önce bir şirket oluştur."); return; }
    setAgentState({ phase: "working", description });
    try { setAgentState({ phase: "done", description, result: await source.composeAgent(companyId, description) }); void refresh(true); }
    catch (e) {
      const msg = (e as { message?: unknown })?.message;
      setAgentState({ phase: "error", description, message: typeof msg === "string" && msg ? msg : "Ajan oluşturulamadı." });
    }
  };
  const runPlan = async (message: string) => {
    if (companies.length === 0) { setNotice("Önce bir şirket oluştur."); return; }
    if (multi && !ws) { setNotice("Önce bir şirket seç."); return; }
    const my = seq.current.next();
    setPlanState({ phase: "planning", message });
    const next = await submitPlan(deps, message, ws);
    if (seq.current.isCurrent(my)) setPlanState(next);
  };
  const submit = (flow: "chat" | "plan" | "agent", text: string) => {
    setNotice(null); seq.current.invalidate(); setPlanState({ phase: "idle" }); setAgentState({ phase: "idle" });
    if (flow === "chat") { setActive({ kind: "chat", text }); return; }
    if (flow === "plan") { setActive({ kind: "plan" }); void runPlan(text); return; }
    setActive({ kind: "agent", description: text }); void runCompose(text);
  };
  const start = async () => {
    if (planState.phase !== "ready" && planState.phase !== "startError") return;
    const my = seq.current.next();
    setPlanState({ ...planState, phase: "starting", error: undefined });
    const next = await submitStart(deps, planState, ws, companies.length);
    if (!seq.current.isCurrent(my)) return;
    setPlanState(next);
    if (next.phase === "started") {
      setNotice("İş başlatıldı: İşler görünümünde izleyebilirsin.");
      setActive(null); setPlanState({ phase: "idle" }); setView("jobs"); setOpenRunId(next.runId); void refresh(true);
    }
  };

  const decide = async (d: "APPROVED" | "REJECTED", note?: string) => {
    const res = await source.decide(reviewing!.approval.id, d, note);
    if (res.kind === "ok" || res.kind === "claimFailed" || res.kind === "stale") {
      setNotice(res.kind === "ok" ? (d === "APPROVED" ? "Onaylandı." : "Reddedildi.") : DECISION_TEXT[res.kind] ?? null);
      setReviewing(null); void refresh(true);
    }
    return res;
  };

  const openRun = ready?.runs.find((r) => r.id === openRunId) ?? null;
  const expected = ready ? expectedFromYou(ready.groups, ready.runs) : { approvals: 0, stuck: 0 };
  const recent = ready ? [...ready.runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3) : [];

  return (
    <main className="uxl-root" aria-label="Prototip UX-04">
      <style>{LAB_CSS}</style>
      <header className="uxl-row">
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Braavolabs · İşler</h1>
          <div style={muted}>Prototip (BRA-UX-04). Bayrak arkasında; mevcut ekranlar değişmedi.</div>
        </div>
        <ModeBadge mode={source.mode} />
      </header>
      {source.mode === "sample" && <div role="note" style={{ ...flat, ...muted }}>Oturum yok ya da örnek kip: veriler ÖRNEKTİR, hiçbir şey sunucuya gitmez.</div>}
      {!online && <div role="status" style={{ ...flat, textAlign: "center" }}>═ Çevrimdışısın · son bilinen durum gösteriliyor (Onayla/Reddet kapalı) ═</div>}
      {notice && <div role="status" style={{ ...flat, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}><span>{notice}</span><button type="button" style={btn} onClick={() => setNotice(null)} aria-label="Bildirimi kapat">✕</button></div>}

      <nav className="uxl-nav" aria-label="Prototip gezinmesi">
        {VIEWS.map(([id, label]) => (
          <button key={id} type="button" aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}>
            {label}{id === "jobs" && expected.approvals > 0 ? ` (${expected.approvals})` : ""}
          </button>
        ))}
      </nav>

      {data.status === "loading" && <div role="status" aria-busy="true" style={flat}>İşler yükleniyor…</div>}
      {data.status === "error" && <Alert onRetry={() => void refresh()}>İşler yüklenemedi: sunucu yanıt vermedi.</Alert>}

      {ready && view === "start" && (
        <div style={{ display: "grid", gap: 16 }}>
          {multi && (
            <label style={{ display: "grid", gap: 4 }}><span style={muted}>Şirket</span>
              <select value={workspaceId} onChange={(e) => { seq.current.invalidate(); setWorkspaceId(e.target.value); setPlanState({ phase: "idle" }); }} style={{ minHeight: 44 }}>
                <option value="">Seç…</option>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></label>
          )}
          <IntentBar busy={planState.phase === "planning" || planState.phase === "starting" || agentState.phase === "working"} onSubmit={submit} />
          {active?.kind === "chat" && <ChatPanel text={active.text} />}
          {active?.kind === "plan" && (
            <PlanPanel state={planState} companies={companies} workspaceId={workspaceId} onWorkspace={setWorkspaceId} onStart={() => void start()}
              onCancel={() => { seq.current.invalidate(); setPlanState({ phase: "idle" }); setActive(null); }}
              onReplan={() => { if ("message" in planState) void runPlan(planState.message); }} />
          )}
          {active?.kind === "agent" && <AgentPanel state={agentState} mode={source.mode} onRetry={() => void runCompose(active.description)} />}

          <div style={{ ...flat }} className="uxl-row" data-testid="uxl-expected">
            <div><strong>Benden beklenen</strong><br /><span style={muted}>{expected.approvals} onay · {expected.stuck} takıldı</span></div>
            <button type="button" style={btn} onClick={() => setView("jobs")}>Aç</button>
          </div>
          <Section title="Son işler">
            {recent.length === 0 ? <span style={muted}>Henüz iş yok. Yukarıdan tarif et.</span> : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
                {recent.map((r) => (
                  <li key={r.id} style={flat}><button type="button" className="uxl-link" onClick={() => { setView("jobs"); setOpenRunId(r.id); }}>
                    <strong>{r.pipeline?.name ?? r.id}</strong> <span style={muted}>· {r.bucket === "done" ? (r.resultStatus === "VERIFIED" ? "bitti ✔ doğrulandı" : "bitti") : r.bucket === "needs_approval" ? "onay bekliyor" : r.bucket === "stuck" ? "takıldı" : "çalışıyor"}</span>
                  </button></li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}
      {ready && view === "jobs" && <JobsView runs={ready.runs} groups={ready.groups} onOpenRun={setOpenRunId} onReview={(approval, title) => setReviewing({ approval, title })} onGoIntent={() => setView("start")} />}
      {ready && view === "company" && <CompanyView companies={ready.companies} runs={ready.runs} groups={ready.groups} />}
      {view === "manage" && <ManageView />}

      {openRun && !reviewing && <JobDrawer run={openRun} source={source} offline={!online} onClose={() => setOpenRunId(null)} onChanged={() => void refresh(true)} />}
      {reviewing && <ApprovalSheet approval={reviewing.approval} title={reviewing.title} offline={!online} onDecide={decide} onClose={() => setReviewing(null)} />}
    </main>
  );
}

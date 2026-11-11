"use client";
/**
 * BRA-UX-05a — Başlangıç: Niyet Çubuğu (ADR-0004), `NEXT_PUBLIC_UX_INTENT` arkasında (bkz. app/start/page.tsx).
 * YALNIZ var olan uçlar: `GET /companies`, `POST /jobs/plan`, `POST /jobs/start`, `POST /companies/:id/agents/compose`.
 * Sohbet ucu YOK (04-design.md §14-a): sohbet seçilirse dürüstçe söylenir; iş kaydı oluşmaz, örnek yanıt uydurulmaz.
 * Plan akışı mevcut `planFlow` durum makinesini (sessiz yutma yok) olduğu gibi kullanır.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { classifyFailure } from "../../lib/localized-error";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { makeGuard, needsWorkspaceChoice, submitPlan, submitStart, workspaceForRequest, type PlanDeps, type PlanState } from "../../lib/planFlow";
import { PlanMessageBox, PlanSkeleton, type T } from "../plan/PlanParts";
import { AgentPanel, type AgentState } from "./AgentPanel";
import { IntentBar, type IntentFlow } from "./IntentBar";
import { PlanPanel } from "./PlanPanel";
import { btn, flat } from "./styles";

type Company = { id: string; name?: string };
type Active = "chat" | "plan" | "agent" | null;
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`);

export default function StartIntent() {
  const t = useTranslations() as unknown as T;
  const locale = useLocale();
  const router = useRouter();
  const { token, hydrated } = useAuthGuard();
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [companiesFailed, setCompaniesFailed] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [active, setActive] = useState<Active>(null);
  const [lastText, setLastText] = useState("");
  const [state, setState] = useState<PlanState>({ phase: "idle" });
  const [agent, setAgent] = useState<AgentState>({ phase: "idle" });
  const [notice, setNotice] = useState<"workspaceRequired" | "noCompany" | null>(null);
  const seq = useRef(makeGuard());

  const loadCompanies = () => {
    if (!token) return;
    setCompaniesFailed(false);
    api.listCompanies(token).then((c) => setCompanies(Array.isArray(c) ? c : [])).catch(() => setCompaniesFailed(true));
  };
  useEffect(() => { if (hydrated && token) loadCompanies(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [hydrated, token]);

  const deps: PlanDeps = { plan: (m, w) => api.jobPlan(token!, m, w), start: (b) => api.jobStart(token!, b), newKey };
  const count = companies?.length ?? 0;
  const multi = needsWorkspaceChoice(count);
  const ws = workspaceForRequest(multi, workspaceId);
  const planning = state.phase === "planning";
  const agentBusy = agent.phase === "working";
  const reset = () => { seq.current.invalidate(); setState({ phase: "idle" }); setAgent({ phase: "idle" }); setActive(null); setNotice(null); };

  const suggest = async (m: string) => {
    if (!token || !m.trim()) return;
    if (count === 0) { setNotice("noCompany"); return; }
    if (multi && !ws) { setNotice("workspaceRequired"); return; }
    setNotice(null);
    const my = seq.current.next();
    setState({ phase: "planning", message: m.trim() });
    const next = await submitPlan(deps, m, ws);
    if (seq.current.isCurrent(my)) setState(next);
  };
  const start = async () => {
    if (state.phase !== "ready" && state.phase !== "startError") return;
    const my = seq.current.next();
    setState({ ...state, phase: "starting", error: undefined });
    const next = await submitStart(deps, state, ws, count);
    if (!seq.current.isCurrent(my)) return;
    setState(next);
    if (next.phase === "started") router.push("/inbox");
  };
  /** Ajanı HEMEN kaydeder (taslak ucu yok): yalnız onay kartındaki düğmeden çağrılır, çubuktan asla. */
  const createAgent = async () => {
    if (!token || (agent.phase !== "confirm" && agent.phase !== "error")) return;
    const companyId = multi ? ws : companies?.[0]?.id;
    if (!companyId) { setAgent({ phase: "confirm", description: agent.description, error: "workspaceRequired" }); return; }
    const description = agent.description;
    const my = seq.current.next();
    setAgent({ phase: "working", description });
    try {
      const r = await api.composeAgent(token, companyId, description);
      if (seq.current.isCurrent(my)) setAgent({ phase: "done", description, result: { name: r.agent.name, role: r.agent.role, tools: r.agent.tools, droppedTools: r.droppedTools } });
    } catch (e) {
      if (seq.current.isCurrent(my)) setAgent({ phase: "error", description, kind: classifyFailure(e) });
    }
  };
  const submit = (flow: IntentFlow, text: string) => {
    reset();
    setLastText(text);
    if (flow === "chat") { setActive("chat"); return; }
    if (flow === "plan") { setActive("plan"); void suggest(text); return; }
    setActive("agent"); setAgent({ phase: "confirm", description: text });
  };

  if (!hydrated || !token) return <main style={{ padding: 24 }} aria-busy="true" />;
  const card = state.phase === "ready" || state.phase === "starting" || state.phase === "startError" ? state : null;

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 16, display: "grid", gap: 12 }} dir={locale === "ar" ? "rtl" : undefined} data-testid="start-intent">
      <h1 style={{ margin: 0 }}>{t("app.intent.title")}</h1>
      {companiesFailed && <PlanMessageBox t={t} kind="alert" body={t("surface.error.generic")} onRetry={loadCompanies} />}
      {companies !== null && count === 0 && (
        <div role="status" style={{ display: "grid", gap: 8 }}>
          <span>{t("app.plan.noCompany")}</span>
          <Link href="/companies/new" style={{ textDecoration: "underline" }}>{t("app.plan.createCompany")}</Link>
        </div>
      )}
      {multi && (
        <label style={{ display: "grid", gap: 4 }}>
          <span>{t("app.plan.workspace")}</span>
          <select value={workspaceId} disabled={planning || agentBusy || state.phase === "starting"} onChange={(e) => { setWorkspaceId(e.target.value); reset(); }} style={{ minHeight: 44 }}>
            <option value="">{t("app.plan.workspaceChoose")}</option>
            {companies!.map((c) => <option key={c.id} value={c.id}>{c.name ?? c.id}</option>)}
          </select>
        </label>
      )}
      <IntentBar t={t} busy={planning || agentBusy || state.phase === "starting" || companies === null} onSubmit={submit} />
      {notice && <div role="alert" style={{ color: "var(--color-error)", fontWeight: 600 }}>{notice === "noCompany" ? t("app.plan.noCompany") : t("app.plan.workspaceRequired")}</div>}
      {active === "chat" && (
        <section style={{ ...flat, display: "grid", gap: 8 }} role="status" data-testid="intent-chat-unavailable">
          <span>{t("app.intent.chat.unavailable")}</span>
          <div><button type="button" style={btn} onClick={() => { setActive("plan"); void suggest(lastText); }}>{t("app.intent.chat.asJob")}</button></div>
        </section>
      )}
      {state.phase === "planning" && <PlanSkeleton t={t} />}
      {state.phase === "empty" && <PlanMessageBox t={t} kind="status" body={t("app.plan.empty")} />}
      {state.phase === "planError" && <PlanMessageBox t={t} kind="alert" body={t(`surface.error.${state.kind}`)} onRetry={() => void suggest(state.message)} />}
      {card && (
        <PlanPanel card={card.card} t={t} locale={locale} busy={card.phase === "starting"} startError={card.phase === "startError" ? card.error : null}
          onStart={() => void start()} onCancel={reset} onReplan={() => void suggest(card.message)} />
      )}
      <AgentPanel state={agent} t={t} onCreate={() => void createAgent()} onCancel={reset} />
    </main>
  );
}

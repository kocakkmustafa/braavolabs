"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { needsWorkspaceChoice, submitPlan, submitStart, type PlanDeps, type PlanState } from "../../lib/planFlow";
import { PlanCardPanel, PlanMessageBox, PlanSkeleton, type T } from "../../components/plan/PlanParts";

type Company = { id: string; name?: string };
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`);

/** Niyet girişi: serbest metin → "Plan öner" (POST /jobs/plan) → plan kartı → "Çalıştır" (POST /jobs/start). */
export default function StartPage() {
  const t = useTranslations() as unknown as T;
  const locale = useLocale();
  const router = useRouter();
  const { token, hydrated } = useAuthGuard();
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [companiesFailed, setCompaniesFailed] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [message, setMessage] = useState("");
  const [state, setState] = useState<PlanState>({ phase: "idle" });
  const seq = useRef(0);

  const loadCompanies = () => {
    if (!token) return;
    setCompaniesFailed(false);
    api.listCompanies(token).then((c) => setCompanies(Array.isArray(c) ? c : [])).catch(() => setCompaniesFailed(true));
  };
  useEffect(() => { if (hydrated && token) loadCompanies(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [hydrated, token]);

  const deps: PlanDeps = {
    plan: (m, w) => api.jobPlan(token!, m, w),
    start: (b) => api.jobStart(token!, b),
    newKey,
  };
  const count = companies?.length ?? 0;
  const multi = needsWorkspaceChoice(count);
  const ws = multi ? workspaceId || undefined : undefined;
  const planning = state.phase === "planning";

  const suggest = async (m: string) => {
    if (!token || !m.trim() || (multi && !ws)) return;
    const my = ++seq.current;
    setState({ phase: "planning", message: m.trim() });
    const next = await submitPlan(deps, m, ws);
    if (my === seq.current) setState(next);
  };
  const start = async () => {
    if (state.phase !== "ready" && state.phase !== "startError") return;
    const my = ++seq.current;
    setState({ ...state, phase: "starting", error: undefined });
    const next = await submitStart(deps, state, ws, count);
    if (my !== seq.current) return;
    setState(next);
    if (next.phase === "started") router.push("/inbox");
  };

  if (!hydrated || !token) return <main style={{ padding: 24 }} aria-busy="true" />;
  const card = state.phase === "ready" || state.phase === "starting" || state.phase === "startError" ? state : null;

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 16, display: "grid", gap: 12 }} dir={locale === "ar" ? "rtl" : undefined}>
      <h1 style={{ margin: 0 }}>{t("app.plan.title")}</h1>
      {companiesFailed && <PlanMessageBox t={t} kind="alert" body={t("surface.error.generic")} onRetry={loadCompanies} />}
      {multi && (
        <label style={{ display: "grid", gap: 4 }}>
          <span>{t("app.plan.workspace")}</span>
          <select value={workspaceId} onChange={(e) => { setWorkspaceId(e.target.value); setState({ phase: "idle" }); }} style={{ minHeight: 44 }}>
            <option value="">{t("app.plan.workspaceChoose")}</option>
            {companies!.map((c) => <option key={c.id} value={c.id}>{c.name ?? c.id}</option>)}
          </select>
        </label>
      )}
      <label style={{ display: "grid", gap: 4 }}>
        <span>{t("app.plan.messageLabel")}</span>
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4} maxLength={4000} placeholder={t("app.plan.messagePlaceholder")} />
      </label>
      <div>
        <button type="button" disabled={planning || !message.trim() || companies === null || (multi && !ws)} onClick={() => void suggest(message)}
          style={{ minHeight: 44, padding: "8px 16px", fontWeight: 600 }}>{t("app.plan.suggest")}</button>
      </div>
      {state.phase === "planning" && <PlanSkeleton t={t} />}
      {state.phase === "empty" && <PlanMessageBox t={t} kind="status" body={t("app.plan.empty")} />}
      {state.phase === "planError" && <PlanMessageBox t={t} kind="alert" body={t(`surface.error.${state.kind}`)} onRetry={() => void suggest(state.message)} />}
      {card && (
        <PlanCardPanel card={card.card} t={t} locale={locale} busy={card.phase === "starting"} startError={card.phase === "startError" ? card.error : null}
          onStart={() => void start()} onCancel={() => { seq.current++; setState({ phase: "idle" }); }} />
      )}
    </main>
  );
}

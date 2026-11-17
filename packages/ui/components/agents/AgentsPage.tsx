"use client";
/**
 * BRA-UX-05g — Ajanlar (bayrak `NEXT_PUBLIC_UX_AGENTS`). Yalnız var olan uçlar: `GET /companies`, `GET /companies/:id/agents`,
 * `POST …/agents/compose/draft` (kayıt YOK) ve `POST …/agents/compose/confirm`. Taslak istemcide tutulur; kayıt yalnız "Oluştur" düğmesiyle.
 * Teknik tanımlayıcılar (araç adı, rol, model) `<bdi dir="ltr">` içinde: RTL'de ok/LTR adı karışmaz. Okunan değer yoksa "Bilinmiyor" yazılır.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { useAppStore } from "../../lib/store";
import { confirmDraft, descriptionProblem, mayBeSaved, requestDraft, toAgentRows, type AgentRow, type ComposeDeps, type ComposerState } from "../../lib/ux-agents/agents";
import { btn, btnPrimary, flat, glass, glassError, muted } from "../start/styles";

type Company = { id: string; name: string };
const ltr = (s: string) => <bdi dir="ltr">{s}</bdi>;
const field: React.CSSProperties = { width: "100%", minWidth: 0, minHeight: 44, padding: "8px 12px", borderRadius: 10, background: "var(--color-surface-container)", color: "var(--color-on-surface)", border: "1px solid var(--color-outline-variant)" };

export default function AgentsPage() {
  const t = useTranslations();
  const locale = useLocale();
  const { token, hydrated } = useAuthGuard();
  const sessionRevision = useAppStore((s) => s.sessionRevision);
  const at = (k: string, v?: Record<string, string | number>) => t(`app.agents.${k}`, v);

  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [companiesFailed, setCompaniesFailed] = useState(false);
  const [companyId, setCompanyId] = useState("");
  const [rows, setRows] = useState<AgentRow[] | null>(null);
  const [rowsFailed, setRowsFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [state, setState] = useState<ComposerState>({ phase: "idle" });
  const seq = useRef(0);
  const listSeq = useRef(0);

  const loadCompanies = useCallback(() => {
    if (!hydrated || !token) return;
    setCompaniesFailed(false);
    api.listCompanies(token)
      .then((r) => {
        const list: Company[] = (Array.isArray(r) ? r : []).filter((c) => c && typeof c.id === "string").map((c) => ({ id: c.id, name: typeof c.name === "string" && c.name ? c.name : c.id }));
        setCompanies(list);
        setCompanyId((cur) => (cur && list.some((c) => c.id === cur) ? cur : list[0]?.id ?? ""));
      })
      .catch(() => setCompaniesFailed(true));
  }, [token, hydrated, sessionRevision]);
  useEffect(() => { loadCompanies(); }, [loadCompanies]);

  const loadRows = useCallback(() => {
    if (!hydrated || !token || !companyId) return;
    const mine = ++listSeq.current;
    setRowsFailed(false);
    api.listAgents(token, companyId)
      .then((r) => { if (mine === listSeq.current) setRows(toAgentRows(r)); })
      .catch(() => { if (mine === listSeq.current) { setRows(null); setRowsFailed(true); } });
  }, [token, hydrated, companyId]);
  useEffect(() => { setRows(null); setState({ phase: "idle" }); seq.current++; loadRows(); }, [loadRows]);

  const deps: ComposeDeps | null = token && companyId ? {
    draft: (d) => api.composeAgentDraft(token, companyId, d),
    confirm: (draft) => api.composeAgentConfirm(token, companyId, draft),
  } : null;
  const busy = state.phase === "drafting" || state.phase === "confirming";
  const problem = descriptionProblem(text);

  const makeDraft = async () => {
    if (!deps || problem || busy) return;
    const my = ++seq.current;
    setState({ phase: "drafting", description: text.trim() });
    const next = await requestDraft(deps, text);
    if (my === seq.current) setState(next);
  };
  const create = async () => {
    if (!deps || busy) return;
    const my = ++seq.current;
    const cur = state;
    const held = cur.phase === "draft" ? cur.result : cur.phase === "error" && cur.stage === "confirm" ? cur.result : undefined;
    if (!held) return;
    setState({ phase: "confirming", description: cur.phase === "draft" || cur.phase === "error" ? cur.description : "", result: held });
    const next = await confirmDraft(deps, cur);
    if (my !== seq.current) return;
    setState(next);
    if (next.phase === "created") { setText(""); loadRows(); }
  };
  const discard = () => { seq.current++; setState({ phase: "idle" }); };

  if (!hydrated || !token) return <main style={{ padding: 24 }} aria-busy="true" />;
  const result = state.phase === "draft" || state.phase === "confirming" ? state.result : state.phase === "error" ? state.result : undefined;

  return (
    <main id="main-content" data-testid="agents-page" dir={locale === "ar" ? "rtl" : undefined} style={{ maxWidth: 840, margin: "0 auto", padding: 16, display: "grid", gap: 14 }}>
      <header style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>{at("title")}</h1>
        <button type="button" data-testid="agents-new" style={btnPrimary} disabled={!companyId} onClick={() => setOpen((o) => !o)} aria-expanded={open}>{at("new")}</button>
      </header>
      {companiesFailed && <div role="alert" style={glassError}>{at("companiesError")} <button type="button" style={btn} onClick={loadCompanies}>{at("retry")}</button></div>}
      {companies !== null && companies.length === 0 && <div role="status" style={flat}>{at("noCompany")}</div>}
      {companies && companies.length > 1 && (
        <label style={{ display: "grid", gap: 4 }}>
          <span style={muted}>{at("company")}</span>
          <select data-testid="agents-company" value={companyId} onChange={(e) => setCompanyId(e.target.value)} style={field}>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      )}

      {open && companyId && (
        <section data-testid="agents-composer" aria-label={at("composerTitle")} style={{ ...glass, display: "grid", gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{at("composerTitle")}</h2>
          <label style={{ display: "grid", gap: 4 }}>
            <span>{at("describe")}</span>
            <textarea data-testid="agents-description" rows={3} value={text} disabled={busy} onChange={(e) => { setText(e.target.value); if (state.phase !== "idle" && state.phase !== "created") discard(); }} placeholder={at("placeholder")} style={{ ...field, resize: "vertical" }} />
          </label>
          {text.length > 0 && problem && <div role="status" data-testid="agents-too-short" style={muted}>{at(problem === "tooShort" ? "tooShort" : "tooLong")}</div>}
          <div><button type="button" data-testid="agents-draft" style={btn} disabled={!!problem || busy} onClick={() => void makeDraft()}>{state.phase === "drafting" ? at("drafting") : at("draftButton")}</button></div>
          <div role="note" style={muted} data-testid="agents-draft-note">{at("draftNote")}</div>

          {state.phase === "error" && (
            <div role="alert" data-testid="agents-error" style={{ ...glassError, display: "grid", gap: 8 }}>
              <span>{at(`error.${state.kind}`)}</span>
              {state.stage === "confirm" && mayBeSaved(state.kind) && <span style={muted} data-testid="agents-maybe-saved">{at("maybeSaved")}</span>}
              {state.stage === "confirm" && result && <div><button type="button" style={btn} onClick={() => void create()}>{at("retry")}</button></div>}
            </div>
          )}

          {result && (
            <article data-testid="agents-draft-preview" aria-label={at("previewTitle")} style={{ ...flat, display: "grid", gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>{at("previewTitle")} <span style={muted}>({at("notSaved")})</span></h3>
              <div><strong>{at("name")}{at("labelSep")}</strong>{result.draft.name}</div>
              <div><strong>{at("role")}{at("labelSep")}</strong>{ltr(result.draft.role)}</div>
              <div><strong>{at("tools")}{at("labelSep")}</strong>{result.draft.tools.length ? result.draft.tools.map((x, i) => <span key={x}>{i > 0 && at("listSep")}{ltr(x)}</span>) : at("none")}</div>
              {result.droppedTools.length > 0 && (
                <div role="alert" data-testid="agents-dropped" style={glassError}>
                  {at("dropped", { count: result.droppedTools.length })}{at("labelSep")}{result.droppedTools.map((x, i) => <span key={x}>{i > 0 && at("listSep")}{ltr(x)}</span>)}
                </div>
              )}
              <details>
                <summary>{at("systemPrompt")}</summary>
                <p style={{ whiteSpace: "pre-wrap", margin: "6px 0 0" }}>{result.draft.systemPrompt}</p>
              </details>
              <div style={muted}>{at("providerLine", { provider: result.provider ?? at("unknown"), model: result.model ?? at("unknown") })}</div>
              {state.phase !== "error" && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" data-testid="agents-confirm" style={btnPrimary} disabled={busy} onClick={() => void create()}>{state.phase === "confirming" ? at("creating") : at("create")}</button>
                  <button type="button" data-testid="agents-discard" style={btn} disabled={busy} onClick={discard}>{at("discard")}</button>
                </div>
              )}
            </article>
          )}

          {state.phase === "created" && (
            <div role="status" data-testid="agents-created" style={flat}>
              <strong>{state.created.name}</strong> {at("created")}
              {state.created.droppedTools.length > 0 && <div style={muted}>{at("dropped", { count: state.created.droppedTools.length })}{at("labelSep")}{state.created.droppedTools.map((x, i) => <span key={x}>{i > 0 && at("listSep")}{ltr(x)}</span>)}</div>}
            </div>
          )}
        </section>
      )}

      <section aria-label={at("listTitle")} style={{ display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{at("listTitle")}</h2>
        {rowsFailed && <div role="alert" data-testid="agents-list-error" style={glassError}>{at("listError")} <button type="button" style={btn} onClick={loadRows}>{at("retry")}</button></div>}
        {rows !== null && rows.length === 0 && <div role="status" data-testid="agents-empty" style={flat}>{at("empty")}</div>}
        {rows?.map((a) => (
          <article key={a.id} data-testid="agent-row" style={{ ...flat, display: "grid", gap: 4, minWidth: 0, overflowWrap: "anywhere" }}>
            <strong>{a.name}</strong>
            <span style={muted}>{at("role")}{at("labelSep")}{a.role ? ltr(a.role) : at("unknown")} {at("pairSep")} {at("company")}{at("labelSep")}{companies?.find((c) => c.id === companyId)?.name ?? at("unknown")}</span>
            <span style={muted}>{at("tools")}{at("labelSep")}{a.tools.length ? a.tools.map((x, i) => <span key={x}>{i > 0 && at("listSep")}{ltr(x)}</span>) : at("none")}</span>
            <span style={muted}>{at("status")}{at("labelSep")}{a.status ?? at("unknown")}</span>
          </article>
        ))}
      </section>
    </main>
  );
}

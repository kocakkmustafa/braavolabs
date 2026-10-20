"use client";
import { LocalizedUiError, useLocalizedFailure } from "../lib/localized-error";


import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { api } from "../lib/api";
import { captureAuthSession, isAuthSessionCurrent, useAppStore, type AuthSessionSnapshot } from "../lib/store";
import { isReasoningEffort, selectionKey, validCompareSelections, type CompareOptions, type CompareResult, type CompareSelection } from "../lib/compare";

type Run = { controller: AbortController };
type Scope = { owner: AuthSessionSnapshot; companyId: string; active: boolean; optionsRequest?: AbortController; run?: Run };
type View = { scope: Scope; query: string; selections: CompareSelection[]; options?: CompareOptions; loading: boolean; busy: boolean; error?: string; result?: CompareResult };
const blank = (scope: Scope): View => ({scope, query: "", selections: [], loading: true, busy: false});

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 2000);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, {once: true});
  });
}

/** Each mounted company/auth owner owns its metadata, submit latch and poll.
 * Retired requests can neither publish results nor unlock a newer submission. */
export default function ComparePanel({ companyId }: { companyId: string }) {
  const describeFailure = useLocalizedFailure();
  const t = useTranslations("app.compare");
  const revision = useAppStore(s => s.sessionRevision);
  const tenantId = useAppStore(s => s.tenantId);
  const scope = useMemo<Scope>(() => ({owner: captureAuthSession(), companyId, active: false}), [revision, tenantId, companyId]);
  const latest = useRef(scope);
  latest.current = scope;
  const [stored, setStored] = useState<View>(() => blank(scope));
  const viewRef = useRef(stored);
  const view = stored.scope === scope ? stored : blank(scope);
  const current = () => scope.active && latest.current === scope && isAuthSessionCurrent(scope.owner);
  const read = () => viewRef.current.scope === scope ? viewRef.current : blank(scope);
  const change = (update: (v: View) => View) => {
    if (!current()) return;
    const next = update(read());
    viewRef.current = next;
    setStored(next);
  };
  const token = () => current() ? useAppStore.getState().token : null;
  const message = (error: unknown) => describeFailure(error, t("requestFailed"));

  async function loadOptions() {
    const accessToken = token();
    if (!accessToken || scope.run) return;
    scope.optionsRequest?.abort();
    const request = new AbortController();
    scope.optionsRequest = request;
    // Retain visible intent while disabling submission until fresh metadata arrives.
    change(v => ({...v, loading: true, options: undefined, error: undefined}));
    try {
      const options = await api.compareOptions(accessToken, companyId, request.signal);
      if (current() && scope.optionsRequest === request) change(v => ({...v, options}));
    } catch (error) {
      if (current() && scope.optionsRequest === request) change(v => ({...v, error: message(error)}));
    } finally {
      if (current() && scope.optionsRequest === request) {
        scope.optionsRequest = undefined;
        change(v => ({...v, loading: false}));
      }
    }
  }

  useEffect(() => {
    scope.active = true;
    void loadOptions();
    return () => {
      scope.active = false;
      scope.optionsRequest?.abort();
      scope.run?.controller.abort();
    };
    // Token rotation within the same owner retains the form and running session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  function edit(update: (v: View) => View) {
    if (!scope.run) change(update);
  }
  function add(key: string) {
    edit(v => {
      const option = v.options?.selections.find(row => selectionKey(row) === key);
      if (!option || v.loading || v.selections.length >= v.options!.maxCandidates || v.selections.some(row => selectionKey(row) === key)) return v;
      return {...v, selections: [...v.selections, {provider: option.provider, model: option.model}], error: undefined};
    });
  }
  function remove(key: string) {
    edit(v => ({...v, selections: v.selections.filter(row => selectionKey(row) !== key)}));
  }
  function move(key: string, direction: number) {
    edit(v => {
      const rows = [...v.selections];
      const i = rows.findIndex(row => selectionKey(row) === key), next = i + direction;
      if (i < 0 || next < 0 || next >= rows.length) return v;
      [rows[i], rows[next]] = [rows[next], rows[i]];
      return {...v, selections: rows};
    });
  }
  function setEffort(key: string, value: string) {
    edit(v => {
      const option = v.options?.selections.find(row => selectionKey(row) === key);
      if (!option || v.loading || (value !== "" && (!isReasoningEffort(value) || !option.reasoningEfforts.includes(value)))) return v;
      return {...v, selections: v.selections.map(row => selectionKey(row) === key
        ? {provider: row.provider, model: row.model, ...(isReasoningEffort(value) ? {reasoningEffort: value} : {})} : row)};
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const accessToken = token(), state = read();
    if (!accessToken || scope.run) return;
    const query = state.query.trim();
    if (state.loading || !validCompareSelections(state.options, state.selections) || query.length < 5 || query.length > 1000) {
      change(v => ({...v, error: t("invalidSelection")}));
      return;
    }
    const run = {controller: new AbortController()};
    scope.run = run; // Synchronous latch: repeated events before a render still submit once.
    const body = {companyId, query, selections: state.selections.map(row => ({...row}))};
    const ownsRun = () => current() && scope.run === run;
    change(v => ({...v, busy: true, error: undefined, result: undefined}));
    try {
      const started = await api.startSelectedCompare(accessToken, body, run.controller.signal);
      if (!ownsRun()) return;
      for (let attempt = 0; attempt < 150; attempt++) {
        const pollToken = token();
        if (!pollToken || !ownsRun()) return;
        const session = await api.compareSession(pollToken, started.id, companyId, run.controller.signal);
        if (!ownsRun()) return;
        if (session.status === "FAILED") throw new LocalizedUiError(t("failed"));
        if (session.status === "CANCELLED") throw new LocalizedUiError(t("cancelled"));
        if (session.status === "COMPLETED") {
          change(v => ({...v, result: session.findings!.multiModel!}));
          return;
        }
        if (attempt < 149) await waitForPoll(run.controller.signal);
      }
      throw new LocalizedUiError(t("timeout"));
    } catch (error) {
      if (ownsRun()) change(v => ({...v, error: message(error)}));
    } finally {
      if (ownsRun()) {
        scope.run = undefined;
        change(v => ({...v, busy: false}));
      }
    }
  }

  const valid = validCompareSelections(view.options, view.selections);
  const available = view.options?.selections.filter(row => !view.selections.some(selected => selectionKey(selected) === selectionKey(row))) ?? [];
  return <section className="bv-glass p-6 space-y-5" aria-label={t("title")}>
    <h2 className="text-lg font-semibold">{t("title")}</h2>
    <p className="text-sm bv-text-muted">{t("synthesisNote")}</p>
    <form onSubmit={submit} className="space-y-4">
      <label className="block text-sm">{t("query")}
        <textarea aria-label={t("query")} required minLength={5} maxLength={1000} rows={4} value={view.query} disabled={view.busy}
          className="bv-input w-full mt-2" onChange={e => edit(v => ({...v, query: e.target.value}))} />
      </label>
      <label className="block text-sm">{t("addModel")}
        <select aria-label={t("addModel")} value="" disabled={view.loading || view.busy || view.selections.length >= 3 || !available.length}
          className="bv-input w-full mt-2" onChange={e => add(e.target.value)}>
          <option value="">{t("chooseModel")}</option>
          {available.map(row => <option key={selectionKey(row)} value={selectionKey(row)}>{row.provider} / {row.model}</option>)}
        </select>
      </label>
      <ol className="space-y-3">
        {view.selections.map((row, i) => {
          const key = selectionKey(row), option = view.options?.selections.find(item => selectionKey(item) === key);
          const unsupported = !option || (row.reasoningEffort !== undefined && !option.reasoningEfforts.includes(row.reasoningEffort));
          return <li key={key} className="bv-glass p-3 space-y-2">
            <div className="text-sm">{i + 1}. {row.provider} / {row.model}</div>
            <label className="block text-sm">{t("effort")}
              <select aria-label={`${t("effort")} ${row.provider} / ${row.model}`} value={row.reasoningEffort ?? ""}
                disabled={view.busy || view.loading || !option} className="bv-input ms-2" onChange={e => setEffort(key, e.target.value)}>
                <option value="">{t("providerDefault")}</option>
                {option?.reasoningEfforts.map(level => <option key={level} value={level}>{t(level)}</option>)}
                {row.reasoningEffort && !option?.reasoningEfforts.includes(row.reasoningEffort)
                  && <option value={row.reasoningEffort} disabled>{t(row.reasoningEffort)} — {t("unavailable")}</option>}
              </select>
            </label>
            {unsupported && !view.loading && <p className="text-sm" role="status">{t("unavailable")}</p>}
            <div className="flex gap-2">
              <button type="button" aria-label={`${t("up")} ${row.provider} / ${row.model}`} disabled={view.busy || i === 0} onClick={() => move(key, -1)}>{t("up")}</button>
              <button type="button" aria-label={`${t("down")} ${row.provider} / ${row.model}`} disabled={view.busy || i === view.selections.length - 1} onClick={() => move(key, 1)}>{t("down")}</button>
              <button type="button" aria-label={`${t("remove")} ${row.provider} / ${row.model}`} disabled={view.busy} onClick={() => remove(key)}>{t("remove")}</button>
            </div>
          </li>;
        })}
      </ol>
      {view.loading && <p role="status">{t("loading")}</p>}
      {!view.loading && view.options?.selections.length === 0 && <p role="status">{t("noModels")}</p>}
      {view.error && <p role="alert" className="text-sm" style={{color: "var(--bv-status-failed)"}}>{view.error}</p>}
      <div className="flex gap-3">
        <button type="button" disabled={view.busy || view.loading} onClick={() => void loadOptions()} className="bv-btn-secondary">{t("refresh")}</button>
        <button type="submit" disabled={view.busy || view.loading || !valid || view.query.trim().length < 5} className="bv-btn-primary">{view.busy ? t("running") : t("start")}</button>
      </div>
      {view.busy && <p role="status">{t("running")}</p>}
    </form>
    {view.result && <div className="space-y-4">
      {view.result.failed.map(row => <p key={selectionKey(row)} role="alert">{row.provider} / {row.model}: {t("failed")}</p>)}
      {view.result.perModel.map(row => <article key={selectionKey(row)} className="bv-glass p-4">
        <h3>{row.provider} / {row.model}</h3>
        <p className="text-sm bv-text-muted">{t("requestedEffort")}: {row.reasoningEffort ? t(row.reasoningEffort) : t("providerDefault")}</p>
        <p className="whitespace-pre-wrap mt-2">{row.answer}</p>
      </article>)}
      <article className="bv-glass p-4">
        <h3>{t("finalAnswer")}</h3>
        <p className="text-sm bv-text-muted">{t("synthesisOutcome")}: {view.result.synthesisStatus}
          {view.result.synthesizer?.provider && ` — ${view.result.synthesizer.provider} / ${view.result.synthesizer.model ?? ""}`}</p>
        {view.result.synthesizerError && <p role="alert">{t("failed")}</p>}
        <p className="whitespace-pre-wrap mt-2">{view.result.finalAnswer}</p>
      </article>
    </div>}
  </section>;
}

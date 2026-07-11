"use client";

/**
 * /ask — Ask-all / Cascade multi-model command panel (Forge P1).
 *
 * The product's "heart": one composer, two ways to spend it —
 *   - Ask-all  → POST /research/compare (packages/api/.../research.router.ts).
 *     ASYNC: reuses the WebResearchSession lifecycle (same one the research
 *     module already uses), so this page starts a session then polls
 *     GET /research/:id until COMPLETED/FAILED/CANCELLED. The full
 *     MultiModelCompareResult (perModel/consensus/disagreements/
 *     finalAnswer/totalCostUsd) lands in session.findings.multiModel.
 *     Compare requires a companyId (WebResearchSession FK is NOT NULL) —
 *     this page reuses the tenant's existing workspace picker pattern
 *     (see app/drafts/page.tsx) rather than inventing a hidden workspace.
 *   - Cascade  → POST /research/cascade (cascade.service.ts#runTenantCascade).
 *     SYNCHRONOUS — cheapest-capable-first, escalates only on low
 *     confidence. No company needed; runs on ALL the tenant's configured
 *     providers.
 *
 * Model selection honesty note: compareAcrossModels() (services/multi-model.ts)
 * does NOT let a caller choose WHICH providers run — it always takes the
 * tenant's configured provider links "in configured order (default row
 * first)" sliced to maxCandidates (hard ceiling 3, MAX_CANDIDATES). So the
 * "model picker" below is a candidate-COUNT stepper (1..min(3, providers)),
 * with the providers that will actually run highlighted in their real
 * configured order — it never claims to let you cherry-pick specific
 * models for ask-all, because the backend can't do that (yet).
 *
 * Both endpoints run exclusively on the tenant's own BYOK provider rows
 * (never a shared/trial key) — so the empty state when zero providers are
 * configured is a real, honest dead end pointing at Settings, not a mock.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { api } from "../../lib/api";
import { useAuthGuard } from "../../lib/useAuthGuard";
import { sounds } from "../../lib/sounds";
import styles from "./ask.module.css";

type Mode = "askAll" | "cascade";

interface ProviderLink {
  provider: string;
  model: string;
  isDefault: boolean;
  fallbackOrder: number | null;
  baseUrl: string | null;
  keyMasked: string | null;
}

interface CompanyRow {
  id: string;
  name: string;
}

interface ModelCandidateAnswer {
  provider: string;
  model: string;
  answer: string;
  tokens: { input: number; output: number };
  costUsd: number;
  durationMs: number;
}

interface ModelCandidateFailure {
  provider: string;
  model: string;
  error: string;
}

interface MultiModelCompareResult {
  perModel: ModelCandidateAnswer[];
  failed: ModelCandidateFailure[];
  synthesis: string;
  consensus: string[];
  disagreements: string[];
  finalAnswer: string;
  synthesisParsed: boolean;
  synthesizer: { provider?: string; model?: string; costUsd: number; durationMs: number } | null;
  synthesizerError?: string;
  totalCostUsd: number;
  budgetExceeded: boolean;
}

interface CascadeAttempt {
  provider: string;
  model: string;
  tier: string;
  confidence: number;
  costUsd: number;
}

interface CascadeResult {
  answer: string;
  provider: string;
  model: string;
  tier: string;
  confidence: number;
  escalated: boolean;
  totalCostUsd: number;
  stoppedReason: string;
  rationale: string;
  attempts: CascadeAttempt[];
}

// Hard backend ceiling — packages/api/src/services/multi-model.ts#MAX_CANDIDATES.
const MAX_CANDIDATES = 3;
const DEFAULT_BUDGET_USD = 0.5;
const POLL_INTERVAL_MS = 1500;
// Safety net only — the compare session itself is bounded by maxCostUsd /
// per-candidate maxTokens on the server; this just stops the UI from
// polling forever if something wedges.
const POLL_TIMEOUT_MS = 120_000;

const STOP_REASON_KEY: Record<string, string> = {
  confident: "app.ask.cascadeStopReasonConfident",
  "frontier-reached": "app.ask.cascadeStopReasonFrontierReached",
  "budget-cap": "app.ask.cascadeStopReasonBudgetCap",
  "max-attempts": "app.ask.cascadeStopReasonMaxAttempts",
};

const TIER_PILL: Record<string, string> = {
  local: "bv-pill-muted",
  cheap: "bv-pill-cyan",
  frontier: "bv-pill-amber",
};

export default function AskPage() {
  const t = useTranslations();
  const { token, hydrated } = useAuthGuard();

  const [mode, setMode] = useState<Mode>("askAll");
  const [prompt, setPrompt] = useState("");

  const [providers, setProviders] = useState<ProviderLink[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [companiesLoaded, setCompaniesLoaded] = useState(false);
  const [companyId, setCompanyId] = useState("");

  const [maxCandidates, setMaxCandidates] = useState(2);
  const [secondOpinion, setSecondOpinion] = useState(false);
  const [budgetUsd, setBudgetUsd] = useState(DEFAULT_BUDGET_USD);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compareResult, setCompareResult] = useState<MultiModelCompareResult | null>(null);
  const [compareCost, setCompareCost] = useState<number | null>(null);
  const [cascadeResult, setCascadeResult] = useState<CascadeResult | null>(null);

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!hydrated || !token) return;
    api
      .listProviderLinks(token)
      .then((d) => setProviders(d.providers ?? []))
      .catch(() => setProviders([]))
      .finally(() => setProvidersLoaded(true));
    api
      .listCompanies(token)
      .then((list: CompanyRow[]) => {
        setCompanies(list ?? []);
        if ((list ?? []).length > 0) setCompanyId(list[0].id);
      })
      .catch(() => setCompanies([]))
      .finally(() => setCompaniesLoaded(true));
  }, [token, hydrated]);

  // Keep the candidate-count stepper inside [1, min(3, providers.length)]
  // once the real provider list is known.
  useEffect(() => {
    if (!providersLoaded || providers.length === 0) return;
    setMaxCandidates((n) => Math.min(Math.max(n, 1), Math.min(MAX_CANDIDATES, providers.length)));
  }, [providersLoaded, providers.length]);

  useEffect(
    () => () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    },
    [],
  );

  const promptMax = mode === "askAll" ? 1000 : 4000;
  const promptValid = prompt.trim().length >= 5 && prompt.length <= promptMax;
  const noProviders = providersLoaded && providers.length === 0;

  const canRun =
    !!token &&
    providersLoaded &&
    providers.length > 0 &&
    promptValid &&
    !running &&
    (mode === "cascade" || (companiesLoaded && !!companyId));

  async function handleRun() {
    if (!token || !canRun) return;
    setError(null);
    setCompareResult(null);
    setCompareCost(null);
    setCascadeResult(null);
    setRunning(true);
    sounds.build();
    try {
      if (mode === "askAll") {
        const { id } = await api.startCompare(token, {
          companyId,
          query: prompt.trim(),
          maxCandidates,
          maxCostUsd: budgetUsd,
        });
        await pollCompare(token, id);
      } else {
        const result = await api.runCascade(token, {
          prompt: prompt.trim(),
          secondOpinion,
          budgetUsdCap: budgetUsd,
        });
        setCascadeResult(result);
        sounds.success();
      }
    } catch (err) {
      setError((err as Error).message);
      sounds.error();
    } finally {
      setRunning(false);
    }
  }

  function pollCompare(tok: string, sessionId: string): Promise<void> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    return new Promise((resolve) => {
      const tick = async () => {
        try {
          const session = await api.getResearchSession(tok, sessionId);
          if (session.status === "COMPLETED") {
            const mm = session.findings?.multiModel as MultiModelCompareResult | undefined;
            if (mm) {
              setCompareResult(mm);
              setCompareCost(session.costUsd ?? mm.totalCostUsd);
              sounds.success();
            } else {
              setError(t("app.ask.errorNoResult"));
              sounds.error();
            }
            resolve();
            return;
          }
          if (session.status === "FAILED" || session.status === "CANCELLED") {
            setError(session.error || t("app.ask.errorGeneric"));
            sounds.error();
            resolve();
            return;
          }
          if (Date.now() > deadline) {
            setError(t("app.ask.errorTimeout"));
            sounds.error();
            resolve();
            return;
          }
          pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
        } catch (err) {
          setError((err as Error).message);
          sounds.error();
          resolve();
        }
      };
      void tick();
    });
  }

  if (!hydrated || !token) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div
          className="w-6 h-6 border-2 rounded-full animate-spin"
          style={{ borderColor: "rgba(59,130,246,0.3)", borderTopColor: "#3B82F6" }}
        />
      </div>
    );
  }

  const activeCandidates = providers.slice(0, maxCandidates);

  return (
    <div className={`bv-dash ${styles.askShell}`}>
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "24px 24px 48px" }}>
        {/* ─── Page head ─── */}
        <div className="bv-page-head bv-rise" style={{ marginBottom: 22 }}>
          <div>
            <div className={styles.kicker}>{t("app.ask.kicker")}</div>
            <h1
              className="bv-display"
              style={{ margin: 0, fontSize: "clamp(26px, 3vw, 36px)", textTransform: "uppercase", letterSpacing: "-0.01em" }}
            >
              {t("app.ask.title")}
            </h1>
            <p className="bv-caption" style={{ marginTop: 6, maxWidth: "64ch" }}>
              {t("app.ask.subtitle")}
            </p>
          </div>
        </div>

        {noProviders ? (
          <NoProvidersEmptyState t={t} />
        ) : (
          <>
            {/* ─── Composer ─── */}
            <section className="bv-glass bv-panel bv-rim bv-rise" style={{ marginBottom: 22 }}>
              <div className="bv-segmented" role="tablist" aria-label={t("app.ask.modeToggleLabel")}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "askAll"}
                  className={mode === "askAll" ? "active" : ""}
                  onClick={() => {
                    sounds.click();
                    setMode("askAll");
                  }}
                >
                  {t("app.ask.modeAskAll")}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "cascade"}
                  className={mode === "cascade" ? "active" : ""}
                  onClick={() => {
                    sounds.click();
                    setMode("cascade");
                  }}
                >
                  {t("app.ask.modeCascade")}
                </button>
              </div>
              <p className="bv-caption" style={{ marginTop: -6 }}>
                {mode === "askAll" ? t("app.ask.modeAskAllDesc") : t("app.ask.modeCascadeDesc")}
              </p>

              {/* prompt */}
              <div>
                <label className="bv-micro" style={{ display: "block", marginBottom: 6 }}>
                  {t("app.ask.promptLabel")}
                </label>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={t("app.ask.promptPlaceholder")}
                  rows={4}
                  maxLength={promptMax}
                  className="w-full px-3.5 py-2.5 rounded-xl text-sm bg-surface-container border border-outline-variant/30 text-on-surface outline-none focus:border-primary/50 transition-colors"
                  style={{ resize: "vertical" }}
                />
                <div
                  className="bv-mono"
                  style={{
                    marginTop: 4,
                    textAlign: "right",
                    fontSize: 11,
                    color: prompt.length > promptMax ? "var(--bv-status-failed)" : "var(--color-outline)",
                  }}
                >
                  {t("app.ask.promptCounter", { count: prompt.length, max: promptMax })}
                </div>
              </div>

              {mode === "askAll" ? (
                <AskAllControls
                  t={t}
                  companies={companies}
                  companiesLoaded={companiesLoaded}
                  companyId={companyId}
                  setCompanyId={setCompanyId}
                  providers={providers}
                  maxCandidates={maxCandidates}
                  setMaxCandidates={setMaxCandidates}
                />
              ) : (
                <CascadeControls t={t} providers={providers} secondOpinion={secondOpinion} setSecondOpinion={setSecondOpinion} />
              )}

              {/* budget + run */}
              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                <div>
                  <label className="bv-micro" style={{ display: "block", marginBottom: 6 }}>
                    {t("app.ask.budgetLabel")}
                  </label>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span className="bv-mono" style={{ color: "var(--color-outline)" }}>
                      $
                    </span>
                    <input
                      type="number"
                      min={0.1}
                      max={10}
                      step={0.1}
                      value={budgetUsd}
                      onChange={(e) => setBudgetUsd(Math.min(10, Math.max(0.1, Number(e.target.value) || DEFAULT_BUDGET_USD)))}
                      className="bv-mono"
                      style={{
                        width: 76,
                        padding: "6px 8px",
                        borderRadius: 8,
                        background: "rgba(5,6,10,0.4)",
                        border: "1px solid var(--bv-glass-border)",
                        color: "var(--color-on-surface)",
                      }}
                    />
                  </div>
                  <p className="bv-caption" style={{ marginTop: 4, maxWidth: "38ch" }}>
                    {t("app.ask.budgetHint")}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleRun}
                  disabled={!canRun}
                  className="bv-btn bv-btn-primary bv-sheen"
                  style={{ opacity: canRun ? 1 : 0.45, cursor: canRun ? "pointer" : "not-allowed" }}
                >
                  {running ? (
                    <span className={styles.thinkingDots} aria-hidden>
                      <span />
                      <span />
                      <span />
                    </span>
                  ) : (
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden>
                      bolt
                    </span>
                  )}
                  {running
                    ? mode === "askAll"
                      ? t("app.ask.runningAskAll", { count: maxCandidates })
                      : t("app.ask.runningCascade")
                    : t("app.ask.runButton")}
                </button>
              </div>

              {mode === "askAll" && companiesLoaded && companies.length === 0 && <NeedsCompanyNotice t={t} />}
            </section>

            {error && <ErrorBanner message={error} onRetry={handleRun} t={t} />}

            {running &&
              !error &&
              (mode === "askAll" ? (
                <AskAllLoadingSkeleton candidates={activeCandidates} t={t} />
              ) : (
                <CascadeLoadingSkeleton t={t} />
              ))}

            {!running && mode === "askAll" && compareResult && (
              <AskAllResults result={compareResult} totalCostUsd={compareCost ?? compareResult.totalCostUsd} t={t} />
            )}

            {!running && mode === "cascade" && cascadeResult && <CascadeResults result={cascadeResult} t={t} />}

            {!running && !error && !compareResult && !cascadeResult && <AskEmptyState t={t} />}
          </>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────  composer sub-controls  ───────────────────────── */

function AskAllControls({
  t,
  companies,
  companiesLoaded,
  companyId,
  setCompanyId,
  providers,
  maxCandidates,
  setMaxCandidates,
}: {
  t: ReturnType<typeof useTranslations>;
  companies: CompanyRow[];
  companiesLoaded: boolean;
  companyId: string;
  setCompanyId: (id: string) => void;
  providers: ProviderLink[];
  maxCandidates: number;
  setMaxCandidates: (n: number) => void;
}) {
  const maxSelectable = Math.max(1, Math.min(MAX_CANDIDATES, providers.length || 1));

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
      <div style={{ flex: "1 1 220px", minWidth: 200 }}>
        <label className="bv-micro" style={{ display: "block", marginBottom: 6 }}>
          {t("app.ask.companyLabel")}
        </label>
        <select
          value={companyId}
          onChange={(e) => {
            sounds.click();
            setCompanyId(e.target.value);
          }}
          disabled={companies.length === 0}
          className="w-full px-3.5 py-2.5 rounded-xl text-sm bg-surface-container border border-outline-variant/30 text-on-surface outline-none focus:border-primary/50 transition-colors"
        >
          {companies.length === 0 && <option value="">{companiesLoaded ? t("app.ask.noCompanies") : "…"}</option>}
          {companies.map((c) => (
            <option key={c.id} value={c.id} style={{ background: "var(--color-surface-container)" }}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div style={{ flex: "1 1 280px", minWidth: 240 }}>
        <label className="bv-micro" style={{ display: "block", marginBottom: 6 }}>
          {t("app.ask.candidateCountLabel")}
        </label>
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          {Array.from({ length: maxSelectable }, (_, i) => i + 1).map((n) => {
            const active = maxCandidates === n;
            return (
              <button
                key={n}
                type="button"
                onClick={() => {
                  sounds.click();
                  setMaxCandidates(n);
                }}
                className="bv-btn bv-btn-ghost bv-btn-sm"
                style={{
                  borderColor: active ? "rgba(59,130,246,0.5)" : undefined,
                  color: active ? "var(--bv-cobalt-glow)" : undefined,
                  background: active ? "rgba(59,130,246,0.08)" : undefined,
                  minWidth: 34,
                }}
                aria-pressed={active}
              >
                {n}
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {providers.slice(0, MAX_CANDIDATES).map((p, i) => (
            <span
              key={`${p.provider}-${p.model}`}
              className={`bv-pill ${i < maxCandidates ? "bv-pill-cyan" : "bv-pill-muted"}`}
              style={{ fontFamily: "var(--bv-font-mono)", fontSize: 10.5 }}
            >
              {p.provider} · {p.model}
              {p.isDefault ? ` · ${t("app.handoff.defaultTag")}` : ""}
            </span>
          ))}
          {providers.length > MAX_CANDIDATES && (
            <span className="bv-pill bv-pill-muted" style={{ fontFamily: "var(--bv-font-mono)", fontSize: 10.5 }}>
              +{providers.length - MAX_CANDIDATES}
            </span>
          )}
        </div>
        <p className="bv-caption" style={{ marginTop: 6 }}>
          {t("app.ask.candidateOrderHint")}
        </p>
      </div>
    </div>
  );
}

function CascadeControls({
  t,
  providers,
  secondOpinion,
  setSecondOpinion,
}: {
  t: ReturnType<typeof useTranslations>;
  providers: ProviderLink[];
  secondOpinion: boolean;
  setSecondOpinion: (v: boolean) => void;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
      <div style={{ flex: "1 1 280px", minWidth: 240 }}>
        <label className="bv-micro" style={{ display: "block", marginBottom: 6 }}>
          {t("app.ask.modelsLabel")}
        </label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {providers.map((p) => (
            <span key={`${p.provider}-${p.model}`} className="bv-pill bv-pill-muted" style={{ fontFamily: "var(--bv-font-mono)", fontSize: 10.5 }}>
              {p.provider} · {p.model}
              {p.isDefault ? ` · ${t("app.handoff.defaultTag")}` : ""}
            </span>
          ))}
        </div>
        <p className="bv-caption" style={{ marginTop: 6 }}>
          {t("app.ask.cascadeLadderHint")}
        </p>
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flex: "1 1 220px", minWidth: 200 }}>
        <input
          type="checkbox"
          checked={secondOpinion}
          onChange={(e) => {
            sounds.click();
            setSecondOpinion(e.target.checked);
          }}
          style={{ width: 16, height: 16, accentColor: "var(--bv-cobalt-glow)", flexShrink: 0 }}
        />
        <span>
          <span className="bv-body" style={{ display: "block", color: "var(--color-on-surface)" }}>
            {t("app.ask.secondOpinionLabel")}
          </span>
          <span className="bv-caption">{t("app.ask.secondOpinionHint")}</span>
        </span>
      </label>
    </div>
  );
}

/* ─────────────────────────  empty / error states  ───────────────────────── */

function AskEmptyState({ t }: { t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="bv-glass bv-rim" style={{ padding: "64px 32px", textAlign: "center" }}>
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          margin: "0 auto 16px",
          background: "rgba(59,130,246,0.08)",
          border: "1px solid rgba(59,130,246,0.18)",
        }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 24, color: "#60A5FA" }} aria-hidden>
          forum
        </span>
      </div>
      <p className="bv-title" style={{ marginBottom: 6 }}>
        {t("app.ask.emptyTitle")}
      </p>
      <p className="bv-caption" style={{ maxWidth: "50ch", margin: "0 auto" }}>
        {t("app.ask.emptyBody")}
      </p>
    </div>
  );
}

function NoProvidersEmptyState({ t }: { t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="bv-glass bv-rim bv-rise" style={{ padding: "64px 32px", textAlign: "center" }}>
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          margin: "0 auto 16px",
          background: "rgba(255,122,26,0.08)",
          border: "1px solid rgba(255,122,26,0.2)",
        }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 24, color: "var(--bv-status-running)" }} aria-hidden>
          vpn_key_off
        </span>
      </div>
      <p className="bv-title" style={{ marginBottom: 6 }}>
        {t("app.ask.noProvidersTitle")}
      </p>
      <p className="bv-caption" style={{ maxWidth: "52ch", margin: "0 auto 18px" }}>
        {t("app.ask.noProvidersBody")}
      </p>
      <Link href="/settings" className="bv-btn bv-btn-primary bv-btn-sm no-underline" style={{ display: "inline-flex" }}>
        <span className="material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden>
          hub
        </span>
        {t("app.ask.connectProviderCta")}
      </Link>
    </div>
  );
}

function NeedsCompanyNotice({ t }: { t: ReturnType<typeof useTranslations> }) {
  return (
    <div
      style={{
        padding: "12px 14px",
        borderRadius: 12,
        background: "rgba(255,122,26,0.06)",
        border: "1px solid rgba(255,122,26,0.2)",
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
      }}
    >
      <span className="material-symbols-outlined" style={{ fontSize: 18, color: "var(--bv-status-running)", flexShrink: 0 }} aria-hidden>
        info
      </span>
      <div style={{ flex: 1 }}>
        <p className="bv-body" style={{ color: "var(--color-on-surface)", marginBottom: 2 }}>
          {t("app.ask.needsCompanyTitle")}
        </p>
        <p className="bv-caption" style={{ marginBottom: 8 }}>
          {t("app.ask.needsCompanyBody")}
        </p>
        <Link href="/companies/new" className="bv-btn bv-btn-ghost bv-btn-sm no-underline" style={{ display: "inline-flex" }}>
          {t("app.ask.createCompanyCta")}
        </Link>
      </div>
    </div>
  );
}

function ErrorBanner({ message, onRetry, t }: { message: string; onRetry: () => void; t: ReturnType<typeof useTranslations> }) {
  return (
    <div
      style={{
        marginBottom: 16,
        padding: "12px 16px",
        borderRadius: 12,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
        background: "rgba(255,77,77,0.08)",
        border: "1px solid rgba(255,77,77,0.22)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="material-symbols-outlined" style={{ fontSize: 16, color: "#FF4D4D" }} aria-hidden>
          error_outline
        </span>
        <span style={{ fontSize: 13, color: "#FF4D4D" }}>{message}</span>
      </div>
      <button type="button" onClick={onRetry} className="bv-btn bv-btn-ghost bv-btn-sm">
        {t("app.ask.retryButton")}
      </button>
    </div>
  );
}

/* ─────────────────────────  loading skeletons  ───────────────────────── */

function AskAllLoadingSkeleton({ candidates, t }: { candidates: ProviderLink[]; t: ReturnType<typeof useTranslations> }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
      {candidates.map((c) => (
        <div key={`${c.provider}-${c.model}`} className={`bv-glass bv-panel bv-rim ${styles.emberPulse}`} style={{ gap: 10 }}>
          <div className="bv-mono" style={{ fontSize: 12, color: "var(--color-on-surface)" }}>
            {c.provider} · {c.model}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className={styles.thinkingDots} aria-hidden>
              <span />
              <span />
              <span />
            </span>
            <span className="bv-caption">{t("app.ask.thinkingLabel")}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function CascadeLoadingSkeleton({ t }: { t: ReturnType<typeof useTranslations> }) {
  return (
    <div className={`bv-glass bv-panel bv-rim ${styles.emberPulse}`} style={{ gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className={styles.thinkingDots} aria-hidden>
          <span />
          <span />
          <span />
        </span>
        <span className="bv-body">{t("app.ask.runningCascade")}</span>
      </div>
      <p className="bv-caption">{t("app.ask.cascadeLoadingHint")}</p>
    </div>
  );
}

/* ─────────────────────────  results — Ask-all  ───────────────────────── */

function AskAllResults({
  result,
  totalCostUsd,
  t,
}: {
  result: MultiModelCompareResult;
  totalCostUsd: number;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="bv-stagger" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <section
        className="bv-glass bv-panel bv-rim"
        style={{ border: "1px solid rgba(59,130,246,0.35)", boxShadow: "0 0 32px rgba(59,130,246,0.10)" }}
      >
        <header className="bv-panel-head">
          <div>
            <h2 className="bv-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 18, color: "var(--bv-cobalt-glow)" }} aria-hidden>
                merge
              </span>
              {t("app.ask.finalAnswerTitle")}
            </h2>
            <div className="bv-caption">
              {result.synthesizer
                ? t("app.ask.synthesizedBy", { provider: result.synthesizer.provider ?? "—", model: result.synthesizer.model ?? "—" })
                : t("app.ask.noSynthesizer")}
            </div>
          </div>
          <span className="bv-mono" style={{ fontSize: 12, color: "var(--color-outline)" }}>
            {fmtUsd(totalCostUsd)}
          </span>
        </header>

        {result.budgetExceeded && (
          <div className="bv-pill bv-pill-amber" style={{ width: "fit-content" }}>
            {t("app.ask.budgetExceededNote")}
          </div>
        )}
        {!result.budgetExceeded && result.synthesizerError && (
          <div className="bv-pill bv-pill-amber" style={{ width: "fit-content" }}>
            {t("app.ask.synthesizerFailedNote")}
          </div>
        )}

        <p className="bv-body" style={{ whiteSpace: "pre-wrap", color: "var(--color-on-surface)", lineHeight: 1.6 }}>
          {result.finalAnswer}
        </p>

        {result.synthesis && (
          <p className="bv-caption" style={{ borderTop: "1px solid var(--bv-glass-border)", paddingTop: 12 }}>
            {result.synthesis}
          </p>
        )}

        {(result.consensus.length > 0 || result.disagreements.length > 0) && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
            {result.consensus.length > 0 && (
              <div style={{ flex: "1 1 220px", minWidth: 200 }}>
                <div className="bv-micro" style={{ marginBottom: 6, color: "var(--bv-cobalt-glow)" }}>
                  {t("app.ask.consensusTitle")}
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                  {result.consensus.map((c, i) => (
                    <li key={i} className="bv-body" style={{ color: "var(--color-on-surface-variant)" }}>
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.disagreements.length > 0 && (
              <div style={{ flex: "1 1 220px", minWidth: 200 }}>
                <div className="bv-micro" style={{ marginBottom: 6, color: "var(--bv-status-running)" }}>
                  {t("app.ask.disagreementsTitle")}
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                  {result.disagreements.map((d, i) => (
                    <li key={i} className="bv-body" style={{ color: "var(--color-on-surface-variant)" }}>
                      {d}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      <div>
        <div className="bv-micro" style={{ marginBottom: 8 }}>
          {t("app.ask.modelsLabel")}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
          {result.perModel.map((c, i) => (
            <section key={i} className="bv-glass bv-panel bv-rim" style={{ gap: 10 }}>
              <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span className="bv-mono" style={{ fontSize: 12, color: "var(--color-on-surface)", fontWeight: 600 }}>
                  {c.provider} · {c.model}
                </span>
                <span className="bv-mono" style={{ fontSize: 11, color: "var(--color-outline)" }}>
                  {fmtUsd(c.costUsd)}
                </span>
              </header>
              <p
                className="bv-body"
                style={{
                  whiteSpace: "pre-wrap",
                  color: "var(--color-on-surface-variant)",
                  lineHeight: 1.55,
                  maxHeight: 260,
                  overflowY: "auto",
                }}
              >
                {c.answer}
              </p>
              <div className="bv-mono" style={{ fontSize: 10.5, color: "var(--color-outline)", display: "flex", justifyContent: "space-between" }}>
                <span>{t("app.ask.tokensLabel", { input: c.tokens.input, output: c.tokens.output })}</span>
                <span>{fmtDuration(c.durationMs)}</span>
              </div>
            </section>
          ))}
          {result.failed.map((f, i) => (
            <section key={`f-${i}`} className="bv-glass bv-panel bv-rim" style={{ gap: 8, borderColor: "rgba(255,77,77,0.25)" }}>
              <header style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="bv-dot bv-failed" aria-hidden />
                <span className="bv-mono" style={{ fontSize: 12, color: "var(--color-on-surface)" }}>
                  {f.provider} · {f.model}
                </span>
              </header>
              <p className="bv-caption" style={{ color: "var(--bv-status-failed)" }}>
                {f.error}
              </p>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────  results — Cascade  ───────────────────────── */

function CascadeResults({ result, t }: { result: CascadeResult; t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="bv-stagger" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <section
        className="bv-glass bv-panel bv-rim"
        style={{ border: "1px solid rgba(59,130,246,0.35)", boxShadow: "0 0 32px rgba(59,130,246,0.10)" }}
      >
        <header className="bv-panel-head">
          <div>
            <h2 className="bv-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 18, color: "var(--bv-cobalt-glow)" }} aria-hidden>
                bolt
              </span>
              {t("app.ask.cascadeAnswerTitle")}
            </h2>
            <div className="bv-caption" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
              <span className="bv-mono">
                {result.provider} · {result.model}
              </span>
              <span className={`bv-pill ${TIER_PILL[result.tier] ?? "bv-pill-muted"}`}>{result.tier}</span>
              {result.escalated && <span className="bv-pill bv-pill-amber">{t("app.ask.cascadeEscalatedBadge")}</span>}
            </div>
          </div>
          <span className="bv-mono" style={{ fontSize: 12, color: "var(--color-outline)" }}>
            {fmtUsd(result.totalCostUsd)}
          </span>
        </header>

        <p className="bv-body" style={{ whiteSpace: "pre-wrap", color: "var(--color-on-surface)", lineHeight: 1.6 }}>
          {result.answer}
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, borderTop: "1px solid var(--bv-glass-border)", paddingTop: 12 }}>
          <div>
            <div className="bv-micro">{t("app.ask.cascadeConfidenceLabel")}</div>
            <div className="bv-numeric" style={{ fontSize: 20 }}>
              {Math.round(result.confidence * 100)}%
            </div>
          </div>
          <div>
            <div className="bv-micro">{t("app.ask.cascadeStopLabel")}</div>
            <div className="bv-body" style={{ color: "var(--color-on-surface-variant)" }}>
              {stopReasonLabel(t, result.stoppedReason)}
            </div>
          </div>
        </div>
        {result.rationale && <p className="bv-caption">{result.rationale}</p>}
      </section>

      <section className="bv-glass bv-panel bv-rim">
        <header className="bv-panel-head">
          <h2 className="bv-title">{t("app.ask.cascadeTraceTitle")}</h2>
        </header>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {result.attempts.map((a, i) => (
            <div
              key={i}
              className="bv-glass"
              style={{ padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span className="bv-mono" style={{ fontSize: 11, color: "var(--color-outline)" }}>
                  #{i + 1}
                </span>
                <span className="bv-mono" style={{ fontSize: 12 }}>
                  {a.provider} · {a.model}
                </span>
                <span className={`bv-pill ${TIER_PILL[a.tier] ?? "bv-pill-muted"}`}>{a.tier}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <span className="bv-mono" style={{ fontSize: 11, color: "var(--color-outline)" }}>
                  {t("app.ask.cascadeConfidenceLabel")}: {Math.round(a.confidence * 100)}%
                </span>
                <span className="bv-mono" style={{ fontSize: 11, color: "var(--color-outline)" }}>
                  {fmtUsd(a.costUsd)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ─────────────────────────  helpers  ───────────────────────── */

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function stopReasonLabel(t: ReturnType<typeof useTranslations>, reason: string): string {
  const key = STOP_REASON_KEY[reason];
  return key ? t(key) : reason;
}

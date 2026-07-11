"use client";

/**
 * Import an existing automation as a Braavolabs Pipeline.
 *
 * Surface for the importer endpoints in
 * packages/api/src/modules/automation-importer/. The user picks a
 * source format, pastes the raw payload, hits Preview to see what'd
 * land + which nodes drop, and then Commit to persist as a Pipeline.
 *
 * Intentionally minimal — no drag-drop / file upload yet. Paste-only
 * keeps the flow synchronous and avoids the multipart / oversized-
 * upload edge cases on day one. File upload is a follow-up.
 */

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { api } from "../../../lib/api";
import { useAuthGuard } from "../../../lib/useAuthGuard";
import styles from "../integrations.module.css";

type Source =
  | "n8n"
  | "claude-automation"
  | "claude-code-routine"
  | "openclaw"
  | "nemoclaw"
  | "mcp"
  | "generic";

// label + hint are localized via app.importAutomation.src<KeyBase>{Label,Hint};
// `sample` (placeholder JSON/markdown) stays in code — it's literal example data.
const SOURCES: { id: Source; keyBase: string; sample: string }[] = [
  {
    id: "n8n",
    keyBase: "N8n",
    sample: '{"name":"My workflow","nodes":[{"type":"n8n-nodes-base.httpRequest","name":"HTTP","parameters":{"url":"https://api.example.com"}}],"connections":{}}',
  },
  {
    id: "claude-automation",
    keyBase: "ClaudeAutomation",
    sample: "## Plan\n\nResearch the topic.\n\n## Implementation\n\nWrite the article.",
  },
  {
    id: "claude-code-routine",
    keyBase: "ClaudeCodeRoutine",
    sample: "---\nrole: auto-dev\n---\n\n## Plan\n\n…",
  },
  {
    id: "openclaw",
    keyBase: "Openclaw",
    sample: '{"name":"My skill","description":"…","tools":[{"name":"search","description":"…"}],"prompts":{"system":"You are…"}}',
  },
  {
    id: "nemoclaw",
    keyBase: "Nemoclaw",
    sample: '{"name":"My skill","tools":[],"prompts":{"system":"You are…"}}',
  },
  {
    id: "mcp",
    keyBase: "Mcp",
    sample: '{"name":"My MCP","tools":[{"name":"search","description":"Web search","inputSchema":{}}]}',
  },
  {
    id: "generic",
    keyBase: "Generic",
    sample: '{"name":"My pipeline","nodes":[{"id":"a","type":"http","config":{"url":"…"}}],"edges":[]}',
  },
];

// Step indicator phases
const STEPS = ["Paste export", "Preview & map", "Forge pipeline"];

export default function ImportAutomationPage() {
  const { token, hydrated } = useAuthGuard();
  const t = useTranslations();
  const [source, setSource] = useState<Source>("n8n");
  const [name, setName] = useState("");
  const [payload, setPayload] = useState("");
  const [preview, setPreview] = useState<{
    name: string;
    description?: string;
    steps: Array<{ id: string; type: string; config: unknown }>;
    dropped: Array<{ id: string; type: string; reason: string }>;
    warnings: string[];
  } | null>(null);
  const [committedId, setCommittedId] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // phase: 0 = paste, 1 = preview/map, 2 = forging/done
  const [phase, setPhase] = useState(0);

  if (!hydrated) return null;

  const currentSource = SOURCES.find((s) => s.id === source)!;

  const onPreview = async () => {
    if (!token) return;
    setLoadingPreview(true);
    setError(null);
    setCommittedId(null);
    try {
      const resp = await api.importAutomationPreview(token, {
        source,
        payload,
        name: name || undefined,
      });
      setPreview({
        name: resp.preview.name,
        description: resp.preview.description,
        steps: resp.preview.steps,
        dropped: resp.droppedNodes,
        warnings: resp.warnings,
      });
      setPhase(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.importAutomation.previewFailed"));
      setPreview(null);
    } finally {
      setLoadingPreview(false);
    }
  };

  const onCommit = async () => {
    if (!token || !preview) return;
    setCommitting(true);
    setError(null);
    setPhase(2);
    try {
      const resp = await api.importAutomationCommit(token, {
        source,
        payload,
        name: name || undefined,
      });
      setCommittedId(resp.pipelineId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.importAutomation.importFailed"));
      setPhase(1);
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className={`bv-dash bv-dash-shell min-h-screen ${styles.integrationsShell}`}>
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-outline-variant/40">
        <div className="flex items-center gap-2 text-sm text-on-surface-variant">
          <Link href="/integrations" className="hover:text-on-surface transition-colors">
            {t("app.importAutomation.back")}
          </Link>
          <span className="material-symbols-outlined text-outline" style={{ fontSize: 14 }}>chevron_right</span>
          <span className="text-on-surface font-medium">Import</span>
        </div>
        <div className="flex items-center gap-3">
          <button className="bv-btn bv-btn-ghost bv-btn-sm flex items-center gap-1.5">
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>search</span>
            <span className="text-on-surface-variant">Search</span>
            <kbd className="ml-1 px-1.5 py-0.5 text-[10px] rounded bg-surface-container border border-outline-variant/50 text-outline font-mono">⌘K</kbd>
          </button>
          <div className="bv-avatar bv-btn-sm text-xs">JH</div>
        </div>
      </div>

      <div className="max-w-[760px] mx-auto px-6 py-10">
        {/* Page head */}
        <div className="bv-page-head mb-8">
          <div>
            {/* eyebrow — mono "> " kicker (dashboard.module.css .kicker, ported).
                Same literal "Integrations" copy as before, no i18n change. */}
            <p className={styles.kicker}>Integrations</p>
            <h1 className="bv-display gradient-text mb-2">{t("app.importAutomation.title")}</h1>
            <p className="bv-body text-on-surface-variant">{t("app.importAutomation.intro")}</p>
          </div>
        </div>

        {/* Step indicator */}
        <div className="flex gap-2 mb-8">
          {STEPS.map((label, i) => (
            <div key={i} className="flex-1 flex flex-col gap-1.5">
              <div
                className="h-[3px] rounded-full transition-all duration-500"
                style={{
                  background: i <= phase
                    ? "linear-gradient(90deg, #3B82F6, #2563EB)"
                    : "var(--bv-steel-shadow)",
                }}
              />
              <span
                className="text-[10px] font-semibold tracking-wider uppercase transition-colors duration-300"
                style={{ color: i <= phase ? "#60A5FA" : "var(--color-outline)" }}
              >
                {label}
              </span>
            </div>
          ))}
        </div>

        {/* ── Phase 0: Paste export ── */}
        {phase === 0 && (
          <div className="bv-glass bv-rim bv-rise p-7 animate-fade-in">
            <p className="bv-micro text-outline mb-1 tracking-widest">Step 1</p>
            <h2 className="bv-headline text-on-surface mb-1">Paste your export</h2>
            <p className="bv-body text-on-surface-variant mb-6">
              Pick the platform, then paste the workflow JSON or drop a file.
            </p>

            {/* Platform picker */}
            <div className="flex flex-wrap gap-2 mb-6">
              {SOURCES.map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setSource(s.id);
                    setPreview(null);
                    setCommittedId(null);
                  }}
                  className={[
                    "bv-btn bv-btn-sm bv-mono transition-all",
                    source === s.id
                      ? "bv-btn-primary"
                      : "bv-btn-ghost",
                  ].join(" ")}
                >
                  {t(`app.importAutomation.src${s.keyBase}Label`)}
                </button>
              ))}
            </div>

            {/* Source hint */}
            <p className="bv-caption text-outline mb-4">{t(`app.importAutomation.src${currentSource.keyBase}Hint`)}</p>

            {/* Pipeline name */}
            <label className="bv-micro text-outline tracking-widest block mb-2">
              {t("app.importAutomation.pipelineName")}{" "}
              <span className="normal-case text-[10px] text-outline/60 font-normal tracking-normal">
                {t("app.importAutomation.optional")}
              </span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("app.importAutomation.namePlaceholder")}
              className="w-full mb-5 px-4 py-2.5 rounded-xl bg-surface-container border border-outline-variant/50 text-on-surface text-sm placeholder:text-outline focus:border-primary/50 focus:outline-none transition-colors"
            />

            {/* Payload textarea */}
            <label className="bv-micro text-outline tracking-widest block mb-2">
              {t("app.importAutomation.sourcePayload")}
            </label>
            <textarea
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              placeholder={currentSource.sample}
              rows={12}
              className="w-full mb-4 px-4 py-3 rounded-xl bg-surface-container-low border border-outline-variant/50 text-on-surface-variant text-xs font-mono focus:border-primary/50 focus:outline-none transition-colors resize-y leading-relaxed"
            />

            {/* Drop zone */}
            <div className="mb-6 rounded-xl border border-dashed border-outline-variant/60 px-4 py-5 text-center text-outline bv-mono text-xs hover:border-primary/30 transition-colors cursor-pointer">
              <span className="material-symbols-outlined text-outline/60 block mb-1" style={{ fontSize: 22 }}>upload_file</span>
              or drop a .json export here
            </div>

            {error && (
              <div className="mb-5 flex items-start gap-3 px-4 py-3 rounded-xl border border-error/30 bg-error/10 text-error text-sm">
                <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 18 }}>error_outline</span>
                <span>{error}</span>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={onPreview}
                disabled={!payload.trim() || loadingPreview}
                className="bv-btn bv-btn-primary disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {loadingPreview ? (
                  <>
                    <span className="material-symbols-outlined animate-spin" style={{ fontSize: 16 }}>progress_activity</span>
                    {t("app.importAutomation.previewing")}
                  </>
                ) : (
                  <>
                    {t("app.importAutomation.preview")}
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_forward</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* ── Phase 1: Preview & map ── */}
        {phase === 1 && preview && (
          <div className="bv-glass bv-rim bv-rise p-7 animate-fade-in">
            <p className="bv-micro text-outline mb-1 tracking-widest">Step 2</p>
            <h2 className="bv-headline text-on-surface mb-1">Preview &amp; map</h2>
            <p className="bv-body text-on-surface-variant mb-6">
              We parsed {preview.steps.length} steps. Map each to a Braavolabs step type.
            </p>

            {/* DAG preview */}
            <div className="flex flex-wrap items-center gap-0 p-5 mb-6 rounded-xl bg-surface-container-low border border-outline-variant/40">
              {preview.steps.map((step, i) => (
                <div key={step.id} className="flex items-center gap-0">
                  <div className="px-3 py-2.5 rounded-xl bg-surface-container border border-outline-variant/50">
                    <span className="bv-micro text-primary/80 block mb-0.5">{step.type}</span>
                    <span className="bv-mono text-on-surface text-[11px]">{step.id}</span>
                  </div>
                  {i < preview.steps.length - 1 && (
                    <span className="material-symbols-outlined text-primary mx-1" style={{ fontSize: 18 }}>arrow_forward</span>
                  )}
                </div>
              ))}
            </div>

            {/* Map table */}
            <div className="bv-micro text-outline tracking-widest mb-3">
              {t("app.importAutomation.stepsCount", { n: preview.steps.length })}
            </div>
            <div className="divide-y divide-outline-variant/30 mb-5">
              {preview.steps.map((step) => (
                <div key={step.id} className="flex items-center justify-between py-3 gap-4">
                  <span className="bv-mono text-on-surface-variant text-[12px] truncate flex-1">{step.id}</span>
                  <span className="material-symbols-outlined text-primary" style={{ fontSize: 16 }}>arrow_forward</span>
                  <select
                    className="px-3 py-2 rounded-xl bg-surface-container border border-outline-variant/50 text-on-surface text-sm focus:border-primary/50 focus:outline-none transition-colors"
                    defaultValue={step.type}
                  >
                    <option value={step.type}>{step.type}</option>
                    <option value="trigger">Trigger</option>
                    <option value="tool">Tool call</option>
                    <option value="branch">Branch</option>
                    <option value="agent">Agent</option>
                    <option value="output">Output</option>
                  </select>
                </div>
              ))}
            </div>

            {/* Dropped nodes */}
            {preview.dropped.length > 0 && (
              <div className="mb-5">
                <div className="bv-micro text-[#FF7A1A] tracking-widest mb-3 flex items-center gap-1.5">
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>warning</span>
                  {t("app.importAutomation.droppedCount", { n: preview.dropped.length })}
                </div>
                <div className="flex flex-col gap-2">
                  {preview.dropped.map((d) => (
                    <div
                      key={d.id}
                      className="px-4 py-3 rounded-xl bg-surface-container border border-outline-variant/40 flex items-start gap-3"
                    >
                      <span className="bv-dot bv-dot" style={{ background: "#FF7A1A", marginTop: 4, flexShrink: 0 }} />
                      <div>
                        <div className="bv-mono text-[#FF7A1A] text-[11px] mb-0.5">{d.type}</div>
                        <div className="bv-caption text-on-surface-variant">{d.reason}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Warnings */}
            {preview.warnings.length > 0 && (
              <ul className="mb-5 flex flex-col gap-1.5 pl-4 list-disc">
                {preview.warnings.map((w, i) => (
                  <li key={i} className="bv-caption text-on-surface-variant">{w}</li>
                ))}
              </ul>
            )}

            {error && (
              <div className="mb-5 flex items-start gap-3 px-4 py-3 rounded-xl border border-error/30 bg-error/10 text-error text-sm">
                <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 18 }}>error_outline</span>
                <span>{error}</span>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => { setPhase(0); setPreview(null); }}
                className="bv-btn bv-btn-ghost flex items-center gap-2"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_back</span>
                Back
              </button>
              <button
                onClick={onCommit}
                disabled={committing}
                className="bv-btn bv-btn-primary disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {committing ? (
                  <>
                    <span className="material-symbols-outlined animate-spin" style={{ fontSize: 16 }}>progress_activity</span>
                    {t("app.importAutomation.importing")}
                  </>
                ) : (
                  <>
                    {t("app.importAutomation.importBtn")}
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>bolt</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* ── Phase 2: Forging / Done ── */}
        {phase === 2 && (
          <div className="bv-glass bv-rim bv-rise p-7 animate-fade-in">
            {committing ? (
              /* Forging in progress */
              <div className="flex flex-col items-center gap-5 py-10">
                <div
                  className="w-16 h-16 rounded-full border-2 border-outline-variant border-t-primary animate-spin"
                />
                <p className="bv-body text-on-surface-variant">Forging pipeline from import…</p>
              </div>
            ) : committedId ? (
              /* Done */
              <div className="flex flex-col items-center gap-5 py-8 text-center">
                <div className="w-16 h-16 rounded-full flex items-center justify-center bg-primary/10 border border-primary/30 glow-cyan">
                  <span className="material-symbols-outlined text-primary" style={{ fontSize: 28 }}>check_circle</span>
                </div>
                <div>
                  <h2 className="bv-headline text-on-surface mb-1">Imported</h2>
                  <p className="bv-body text-on-surface-variant">
                    {t("app.importAutomation.created")}{" "}
                    <Link
                      href={`/pipelines/${committedId}`}
                      className="text-primary underline underline-offset-2 hover:text-primary/80 transition-colors"
                    >
                      {t("app.importAutomation.openIt")}
                    </Link>
                  </p>
                </div>
                <div className="flex gap-3 mt-2">
                  <Link
                    href={`/pipelines/${committedId}`}
                    className="bv-btn bv-btn-primary flex items-center gap-2"
                  >
                    Open in builder
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>open_in_new</span>
                  </Link>
                  <button
                    onClick={() => { setPhase(0); setPreview(null); setCommittedId(null); setPayload(""); setName(""); }}
                    className="bv-btn bv-btn-ghost"
                  >
                    Import another
                  </button>
                </div>
              </div>
            ) : null}

            {error && (
              <div className="mt-5 flex items-start gap-3 px-4 py-3 rounded-xl border border-error/30 bg-error/10 text-error text-sm">
                <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 18 }}>error_outline</span>
                <span>{error}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

"use client";
import { useLocalizedFailure } from "../lib/localized-error";

import { useTranslations as useRuntimeTranslations } from "next-intl";

import { useTranslations as useLegacyTranslations } from "next-intl";


/**
 * Starter picker — a row of pre-baked company cards above the freeform
 * "describe your company" textarea on /companies/new.
 *
 * Why above and not instead-of? Freeform creation is a sabit ürün karari
 * (CLAUDE.md). The starter cards are an alternative entry path for users
 * who don't yet know what they want — they pick something close, see it
 * work, then iterate. Power users skip this row entirely.
 *
 * The list is fetched from /starters (public endpoint) so the cards
 * render even before the user signs in. The clone call is auth-gated.
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";

interface StarterTemplateSummary {
  id: string;
  name: string;
  tagline: string;
  emoji: string;
  description: string;
  outcome: string;
  trialCost: number;
  primitives: string[];
  agentCount: number;
  pipelineCount: number;
  pipelineSteps: number;
}

interface StarterPickerProps {
  /** Auth token. Required for clone — when missing, click is disabled
   * and the card hints "sign in to use". */
  token: string | null | undefined;
  /** Called after a successful clone with the new company's id + slug.
   * The parent typically routes to `/companies/${id}`. */
  onCloned: (company: { id: string; slug: string; name: string }, message: string) => void;
}

export default function StarterPicker({ token, onCloned }: StarterPickerProps) {
  const describeFailure = useLocalizedFailure();
  const runtimeCopy = useRuntimeTranslations("runtime");
  const uiText = useLegacyTranslations("uiCopy");
  const copy = useLegacyTranslations("app.starters");
  const [templates, setTemplates] = useState<StarterTemplateSummary[]>([]);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.starters
      .list()
      .then((r) => {
        if (alive) setTemplates(r.templates);
      })
      .catch(() => {
        // Silent — picker hides if catalog fetch fails. The freeform
        // textarea below stays visible, so the user has a path forward.
        if (alive) setTemplates([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (templates.length === 0) return null;

  async function clone(templateId: string) {
    if (!token) {
      setError(runtimeCopy("mb39b93c48c24"));
      return;
    }
    setLoadingId(templateId);
    setError(null);
    try {
      const result = await api.starters.clone(token, templateId);
      onCloned(result.company, result.message);
    } catch (err) {
      setError(describeFailure(err, runtimeCopy("m2eb2d91c4f3b")));
    } finally {
      setLoadingId(null);
    }
  }

  return (
    <div className="mb-6">
      <div className="flex items-end justify-between mb-3 px-1">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: "var(--color-info)" }}>{uiText("m0de88f4db3d7")}</h2>
          <p className="text-xs mt-0.5" style={{ color: "var(--color-on-surface-variant)" }}>{copy("intro")}</p>
        </div>
      </div>

      {error && (
        <div
          className="mb-3 px-4 py-2 rounded-xl text-sm"
          style={{
            background: "rgba(239,68,68,0.1)",
            border: "1px solid rgba(239,68,68,0.2)",
            color: "var(--color-error)",
          }}
        >
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {templates.map((t) => {
          const busy = loadingId === t.id;
          return (
            <button
              key={t.id}
              type="button"
              disabled={busy || !!loadingId}
              onClick={() => clone(t.id)}
              className="text-left rounded-2xl p-4 transition-all hover:brightness-110 disabled:opacity-60 disabled:cursor-wait"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
              }}
              aria-label={runtimeCopy("mcdd1de1ae01a", { value0: t.name })}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="text-2xl leading-none">{t.emoji}</div>
                <span
                  className="text-[10px] px-2 py-0.5 rounded-full"
                  style={{
                    background: "rgba(0,209,255,0.08)",
                    color: "var(--color-info)",
                    border: "1px solid rgba(0,209,255,0.2)",
                  }}
                >
                  {t.trialCost === 1 ? copy("trialRunOne") : copy("trialRuns", { count: t.trialCost })}
                </span>
              </div>

              <div className="mt-3 font-semibold text-sm" style={{ color: "var(--color-on-surface)" }}>
                {t.name}
              </div>
              <div className="mt-1 text-xs leading-relaxed" style={{ color: "var(--color-on-surface-variant)" }}>
                {t.tagline}
              </div>

              <div className="mt-3 flex items-center gap-3 text-[11px]" style={{ color: "var(--color-on-surface-variant)" }}>
                <span title={runtimeCopy("ma5a28bb26fde", { count: t.agentCount })}>
                  <span className="material-symbols-outlined align-middle" style={{ fontSize: 12 }}>
                    person
                  </span>{" "}
                  {t.agentCount}
                </span>
                <span title={runtimeCopy("m014789a56e1d", { count: t.pipelineSteps })}>
                  <span className="material-symbols-outlined align-middle" style={{ fontSize: 12 }}>
                    account_tree
                  </span>{" "}
                  {t.pipelineSteps}
                </span>
              </div>

              <div className="mt-3 text-[11px]" style={{ color: "var(--color-success)" }}>
                {busy ? (
                  <>
                    <span className="inline-block w-3 h-3 border-2 border-emerald-300 border-t-transparent rounded-full animate-spin align-middle mr-1" />{uiText("mf6e156140dd9")}</>
                ) : (
                  <>→ {t.outcome}</>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="text-center mt-4">
        <span className="text-[11px] uppercase tracking-wide" style={{ color: "var(--color-on-surface-variant)" }}>{uiText("m454ee6911d47")}</span>
      </div>
    </div>
  );
}

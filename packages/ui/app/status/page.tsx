"use client";
import { useDisplayFormats } from "../../lib/useDisplayFormats";

import { useTranslations as useRuntimeTranslations } from "next-intl";

import { useTranslations as useLegacyTranslations } from "next-intl";


import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { API_BASE } from "../../lib/api";
import { PUBLIC_NAV_LABEL_KEYS } from "../../lib/public-nav-labels";

// ─── Honest status ───────────────────────────────────────────────────
//
// Everything on this page is derived from a LIVE probe of the public
// API health endpoint (GET /api/v1/health → { status: "ok" | "degraded" },
// HTTP 200/503). No fabricated uptime percentages, no invented incident
// history — we don't run an uptime tracker yet, so we don't pretend to.

const REFRESH_MS = 60_000;

type ProbeState = "checking" | "ok" | "degraded" | "down";

interface Probe {
  state: ProbeState;
  checkedAt: Date | null;
}

const STATE_COLOR: Record<ProbeState, string> = {
  checking: "var(--color-outline)",
  ok: "var(--bv-status-completed)",
  degraded: "var(--bv-status-running)",
  down: "var(--bv-status-failed)",
};

function useApiHealth(): Probe {
  const [probe, setProbe] = useState<Probe>({ state: "checking", checkedAt: null });

  const check = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/health`, { cache: "no-store" });
      // 503 still carries { status: "degraded" } — a reachable-but-
      // degraded API is a different (and more informative) signal than
      // an unreachable one.
      const body = await res.json().catch(() => null);
      const state: ProbeState =
        res.ok && body?.status === "ok" ? "ok" : "degraded";
      setProbe({ state, checkedAt: new Date() });
    } catch {
      setProbe({ state: "down", checkedAt: new Date() });
    }
  }, []);

  useEffect(() => {
    void check();
    const id = setInterval(() => void check(), REFRESH_MS);
    return () => clearInterval(id);
  }, [check]);

  return probe;
}

function StatusDot({ state, size = 9 }: { state: ProbeState; size?: number }) {
  return (
    <span
      className={state === "checking" ? "bv-dot" : "bv-dot bv-ping"}
      style={{ width: size, height: size, background: STATE_COLOR[state] }}
    />
  );
}

export default function StatusPage() {
  const displayFormat = useDisplayFormats();
  const runtimeCopy = useRuntimeTranslations("runtime");
  const uiText = useLegacyTranslations("uiCopy");
  const t = useTranslations();
  const probe = useApiHealth();

  const bannerTitle: Record<ProbeState, string> = {
    checking: "Checking system status…",
    ok: t("static.status.title"), // "All systems operational"
    degraded: "API degraded — some requests may fail",
    down: "API unreachable",
  };

  const rowLabel: Record<ProbeState, string> = {
    checking: "Checking…",
    ok: t("static.status.operational"),
    degraded: "Degraded",
    down: "Unreachable",
  };

  return (
    <div className="bv-mesh min-h-screen" style={{ fontFamily: "var(--bv-font-body)" }}>
      {/* ── Nav ───────────────────────────────────────── */}
      <nav
        className="flex items-center justify-between px-6 md:px-10 py-4 max-w-[1100px] mx-auto"
        style={{ borderBottom: "1px solid var(--bv-glass-border)" }}
      >
        <a href="/" className="flex items-center gap-2.5 no-underline">
          <div className="bv-avatar" style={{ width: 32, height: 32, borderRadius: 10 }}>
            AI
          </div>
          <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
        </a>
        <div className="flex items-center gap-3">
          <a
            href="/"
            className="bv-btn bv-btn-ghost bv-btn-sm flex items-center gap-1.5 no-underline"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 15 }}>arrow_back</span>
            {t("static.common.back")}
          </a>
        </div>
      </nav>

      {/* ── Page head ─────────────────────────────────── */}
      <div className="max-w-[860px] mx-auto px-6 pt-14 pb-4">
        {/* eyebrow */}
        <p className="bv-micro mb-3 flex items-center gap-2">
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>monitor_heart</span>{uiText("m20bb133b046a")}</p>

        {/* Banner — live result of the health probe */}
        <div
          className="bv-glass flex items-center gap-4 px-6 py-5 mb-8"
          style={{ borderRadius: 16 }}
        >
          <span
            className={probe.state === "checking" ? "bv-dot" : "bv-dot bv-ping"}
            style={{
              width: 14,
              height: 14,
              flexShrink: 0,
              background: STATE_COLOR[probe.state],
              boxShadow: probe.state === "checking" ? "none" : `0 0 16px ${STATE_COLOR[probe.state]}`,
            }}
          />
          <div className="flex-1 min-w-0">
            <h1
              className="bv-headline"
              style={{ fontSize: "clamp(18px,3vw,28px)", textTransform: "uppercase", letterSpacing: "-0.01em" }}
            >
              {bannerTitle[probe.state]}
            </h1>
          </div>
          <div className="flex items-center gap-2 bv-mono" style={{ color: "var(--color-outline)", flexShrink: 0 }}>
            <StatusDot state={probe.state} size={7} />
            <span>{uiText("ma8e7dcac27dd")}</span>
          </div>
        </div>

        {/* ── Live checks ───────────────────────────────── */}
        <div className="bv-glass" style={{ borderRadius: 16, overflow: "hidden" }}>
          {/* API — probed live against the public health endpoint */}
          <div
            className="flex items-center gap-4 px-5 py-4"
            style={{ borderBottom: "1px solid var(--bv-glass-border)" }}
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-on-surface">API</div>
              <div className="bv-mono mt-0.5" style={{ color: "var(--color-outline)" }}>{uiText("m6391d95c11d5")}</div>
            </div>
            <div
              className="flex items-center gap-2 bv-mono"
              style={{ minWidth: 110, justifyContent: "flex-end", color: STATE_COLOR[probe.state] }}
            >
              <StatusDot state={probe.state} />
              {rowLabel[probe.state]}
            </div>
          </div>

          {/* Website — self-evident: this page is being served */}
          <div className="flex items-center gap-4 px-5 py-4">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-on-surface">
                {t("static.status.services.website")}
              </div>
              <div className="bv-mono mt-0.5" style={{ color: "var(--color-outline)" }}>{uiText("m064d3ea1b787")}</div>
            </div>
            <div
              className="flex items-center gap-2 bv-mono"
              style={{ minWidth: 110, justifyContent: "flex-end", color: "var(--bv-status-completed)" }}
            >
              <StatusDot state="ok" />
              {t("static.status.operational")}
            </div>
          </div>
        </div>

        {/* checked-at + honesty note */}
        <div className="bv-mono mt-3 px-1" style={{ color: "var(--color-outline)" }}>
          {probe.checkedAt
            ? runtimeCopy("m67cb524a0f61", { value0: displayFormat.time(probe.checkedAt) })
            :uiText("m8b59895f3ed7")}
        </div>
        <p className="bv-caption mt-4 mb-14 px-1" style={{ color: "var(--color-on-surface-variant)" }}>{uiText("m9f956da25b83")}</p>

        {/* ── Alert box ─────────────────────────────────── */}
        <div
          className="bv-glass px-5 py-4 mb-16 text-sm"
          style={{
            borderRadius: 14,
            borderColor: "rgba(59,130,246,0.2)",
            color: "var(--color-on-surface-variant)",
          }}
        >
          <strong className="text-on-surface">{t("static.status.alertTitle")}</strong>{" "}
          {t("static.status.alertBody")}
        </div>
      </div>

      {/* ── Footer nav ────────────────────────────────── */}
      <footer
        className="border-t max-w-[1100px] mx-auto px-6 py-8"
        style={{ borderColor: "var(--bv-glass-border)" }}
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          <div>
            <a href="/" className="flex items-center gap-2 mb-3 no-underline">
              <div className="bv-avatar" style={{ width: 28, height: 28, borderRadius: 8, fontSize: 10 }}>AI</div>
              <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
            </a>
            <p className="bv-caption" style={{ color: "var(--color-outline)" }}>{uiText("m4cb64ff7172c")}</p>
          </div>
          <div>
            <h5 className="bv-micro mb-3">{uiText("m8a200d2fa01b")}</h5>
            <div className="flex flex-col gap-2">
              {(["Features", "Pricing", "Changelog"] as const).map((l) => (
                <a key={l} href={`/${l.toLowerCase()}`} className="bv-caption text-on-surface-variant hover:text-on-surface transition-colors no-underline">{t(PUBLIC_NAV_LABEL_KEYS[l])}</a>
              ))}
            </div>
          </div>
          <div>
            <h5 className="bv-micro mb-3">{uiText("mf293e311adbd")}</h5>
            <div className="flex flex-col gap-2">
              {(["About", "Blog", "Contact"] as const).map((l) => (
                <a key={l} href={`/${l.toLowerCase()}`} className="bv-caption text-on-surface-variant hover:text-on-surface transition-colors no-underline">{t(PUBLIC_NAV_LABEL_KEYS[l])}</a>
              ))}
            </div>
          </div>
          <div>
            <h5 className="bv-micro mb-3">{uiText("me036901f0c5c")}</h5>
            <div className="flex flex-col gap-2">
              {(["Privacy", "Terms", "KVKK"] as const).map((l) => (
                <a key={l} href={`/${l.toLowerCase()}`} className="bv-caption text-on-surface-variant hover:text-on-surface transition-colors no-underline">{l === "KVKK" ? l : t(PUBLIC_NAV_LABEL_KEYS[l])}</a>
              ))}
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

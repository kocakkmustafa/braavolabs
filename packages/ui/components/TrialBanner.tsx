"use client";

/**
 * Trial LLM banner — surfaced on the dashboard when a FREE-plan tenant
 * has remaining trial credits AND when their credit just ran out.
 *
 * Three visual states:
 *   1. trial.exhausted=false, remaining > 0 → arc-blue "X free runs left"
 *      (Forge palette has no green — see app/globals.css bv-* tokens /
 *      app/forge/forge-hero.module.css)
 *   2. trial.exhausted=true                  → amber "Trial used up — add API key or upgrade"
 *   3. trial.enabled=false                   → render nothing (paid tenants
 *      and self-hosted operators with no GROQ_API_KEY)
 *
 * Self-fetches on mount so any page that imports it stays decoupled from
 * the parent's data flow. Cheap call (single SQL row) and the banner is
 * idle once the tenant upgrades — no polling.
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import Link from "next/link";

interface TrialState {
  enabled: boolean;
  used: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
}

interface TrialBannerProps {
  /** Auth token. Banner stays hidden when missing — there's no anonymous
   * trial state worth showing. */
  token: string | null | undefined;
}

export default function TrialBanner({ token }: TrialBannerProps) {
  const [trial, setTrial] = useState<TrialState | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    (async () => {
      try {
        // /users/me returns trial alongside profile so we don't need a
        // dedicated endpoint. If the call fails, banner stays hidden —
        // we never want a transient API blip to scare users with a
        // "trial exhausted" message that wasn't true.
        const me = await api.users.me(token);
        if (alive && me?.trial) setTrial(me.trial as TrialState);
      } catch {
        // Ignore — banner is non-critical.
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  // Hide for paid plans, self-hosted-no-Groq, or while loading.
  if (!trial || !trial.enabled) return null;
  if (dismissed && !trial.exhausted) return null;

  if (trial.exhausted) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mb-6 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5 text-sm"
      >
        <div className="flex items-start gap-3">
          <span
            className="material-symbols-outlined text-amber-300"
            aria-hidden
          >
            local_fire_department
          </span>
          <div className="flex-1">
            <p className="font-semibold text-amber-200">
              Your {trial.limit} free trial runs are used up.
            </p>
            <p className="mt-1 text-amber-100/80">
              To keep running pipelines, add your own AI provider API key in
              Settings (BYOK — works with Anthropic, OpenAI, Google, Groq, and 8
              more) or upgrade to a paid plan.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                href="/settings"
                className="rounded-full bg-amber-300 px-4 py-1.5 text-xs font-semibold text-amber-950 transition hover:bg-amber-200"
              >
                Add API key
              </Link>
              <Link
                href="/pricing"
                className="rounded-full border border-amber-300/50 px-4 py-1.5 text-xs font-semibold text-amber-100 transition hover:bg-amber-500/15"
              >
                See pricing
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="mb-6 rounded-2xl border border-blue-500/30 bg-blue-500/10 p-5 text-sm bv-rim"
    >
      <div className="flex items-start gap-3">
        <span
          className="material-symbols-outlined text-blue-300"
          aria-hidden
        >
          rocket_launch
        </span>
        <div className="flex-1">
          <p className="font-semibold text-blue-200">
            {trial.remaining} of {trial.limit} free trial runs left
          </p>
          <p className="mt-1 text-blue-100/80">
            We'll route the next {trial.remaining}{" "}
            {trial.remaining === 1 ? "pipeline run" : "pipeline runs"} through
            our Groq trial pool — no API key required. After that, add your own
            key (BYOK) to keep running.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="text-blue-200/70 transition hover:text-blue-100"
          aria-label="Dismiss"
        >
          <span className="material-symbols-outlined text-base">close</span>
        </button>
      </div>
    </div>
  );
}

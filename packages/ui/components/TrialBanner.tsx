"use client";
import { useTranslations as useLegacyTranslations } from "next-intl";


/**
 * Trial LLM banner — surfaced on the dashboard when a FREE-plan tenant
 * has remaining trial credits AND when their credit just ran out.
 *
 * Three visual states:
 *   1. trial.exhausted=false, remaining > 0 → green "X free runs left"
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
  const uiText = useLegacyTranslations("uiCopy");
  const copy = useLegacyTranslations("app.trial");
  const common = useLegacyTranslations("app.settings");
  const [loadedTrial, setTrial] = useState<{ token: string; data: TrialState } | null>(null);
  const trial = loadedTrial && loadedTrial.token === token ? loadedTrial.data : null;
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
        if (alive && me?.trial) setTrial({ token, data: me.trial as TrialState });
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
            <p className="font-semibold text-on-surface">{copy("exhausted", { limit: trial.limit })}</p>
            <p className="mt-1 text-on-surface-variant">{copy("funding")}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                href="/settings"
                className="rounded-full bg-amber-300 px-4 py-1.5 text-xs font-semibold text-amber-950 transition hover:bg-amber-200"
              >{uiText("m7b55bcf0daed")}</Link>
              <Link
                href="/pricing"
                className="rounded-full border border-amber-300/50 px-4 py-1.5 text-xs font-semibold text-on-surface transition hover:bg-amber-500/15"
              >{common("viewPlans")}</Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="mb-6 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-5 text-sm"
    >
      <div className="flex items-start gap-3">
        <span
          className="material-symbols-outlined text-emerald-300"
          aria-hidden
        >
          rocket_launch
        </span>
        <div className="flex-1">
          <p className="font-semibold text-on-surface">
            {copy("remaining", { count: trial.remaining, limit: trial.limit })}</p>
          <p className="mt-1 text-on-surface-variant">{copy("funding")}</p>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="text-on-surface-variant transition hover:text-on-surface p-2 min-w-11 min-h-11"
          aria-label={uiText("m6a6c1557497e")}
        >
          <span className="material-symbols-outlined text-base">close</span>
        </button>
      </div>
    </div>
  );
}

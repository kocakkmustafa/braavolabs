"use client";
import { useLocalizedFailure } from "../../../lib/localized-error";

import { useTranslations as useRuntimeTranslations } from "next-intl";

import { useLocale as useDisplayLocale } from "next-intl";
import { formatDateTime as formatDisplayDateTime, currentTimeZone as displayTimeZone } from "../../../i18n/locales";

import { useTranslations as useLegacyTranslations } from "next-intl";


/**
 * Settings → Identity Provider (Enterprise SSO).
 *
 * Owner/admin-only surface. The plan gate is enforced server-side
 * (BUSINESS+); we still surface a friendly explainer here when the
 * API returns 402 so the user knows what to upgrade to.
 *
 * Form fields mirror the OIDC well-known set:
 *   issuer            (https://login.microsoftonline.com/{tid}/v2.0)
 *   client_id         (app registration / client ID)
 *   client_secret     (only required on create; blank on edit = keep)
 *   redirect_uri      (your-domain.com/api/v1/auth/sso/{slug}/callback)
 *   scopes            (default "openid email profile")
 *   domains           (comma-separated email-domain allowlist)
 *   discovery_url     (override if issuer's .well-known is unusual)
 *
 * After save, a "Test sign-in" button opens /api/v1/auth/sso/{slug}
 * in a new tab so the admin can verify the round-trip without
 * locking themselves out of the dashboard.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { api } from "../../../lib/api";
import { useAuthGuard } from "../../../lib/useAuthGuard";

type ConfigShape = Awaited<ReturnType<typeof api.getOidcConfig>>;

export default function IdentitySettingsPage() {
  const describeFailure = useLocalizedFailure();
  const runtimeCopy = useRuntimeTranslations("runtime");
  const displayLocale = useDisplayLocale();
  const uiText = useLegacyTranslations("uiCopy");
  const t = useTranslations("app.settings.identity");
  const { token, hydrated } = useAuthGuard();
  const [config, setConfig] = useState<ConfigShape | null>(null);
  const [planGate, setPlanGate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Form state
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [scopes, setScopes] = useState("openid email profile");
  const [domains, setDomains] = useState("");
  const [discoveryUrl, setDiscoveryUrl] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [tenantSlug, setTenantSlug] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const cfg = await api.getOidcConfig(token);
      const me = await api.users.me(token);
      setTenantSlug(me.tenant.slug);
      if (cfg) {
        setConfig(cfg);
        setIssuer(cfg.issuer);
        setClientId(cfg.clientId);
        setRedirectUri(cfg.redirectUri);
        setScopes(cfg.scopes);
        setDomains(cfg.domains);
        setDiscoveryUrl(cfg.discoveryUrl ?? "");
        setIsActive(cfg.isActive);
      }
      setPlanGate(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Business or Enterprise/i.test(msg) || /402/.test(msg)) {
        setPlanGate(true);
      } else if (!/404/.test(msg)) {
        setError(describeFailure(err));
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!hydrated) return;
    load();
  }, [hydrated, load]);

  async function save() {
    if (!token) return;
    setSaving(true);
    setError(null);
    try {
      const body: Parameters<typeof api.saveOidcConfig>[1] = {
        issuer: issuer.trim(),
        clientId: clientId.trim(),
        redirectUri: redirectUri.trim(),
        scopes: scopes.trim() || undefined,
        domains: domains.trim() || undefined,
        discoveryUrl: discoveryUrl.trim() || undefined,
        isActive,
      };
      if (clientSecret) body.clientSecret = clientSecret;
      await api.saveOidcConfig(token, body);
      setSavedAt(Date.now());
      setClientSecret(""); // never echo back, even into local state
      await load();
    } catch (err) {
      setError(describeFailure(err, runtimeCopy("m69c8b86fae03")));
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    if (!token) return;
    if (!confirm(t("confirm_disconnect"))) return;
    setSaving(true);
    try {
      await api.deleteOidcConfig(token);
      setConfig(null);
      setIssuer("");
      setClientId("");
      setClientSecret("");
      setRedirectUri("");
      setScopes("openid email profile");
      setDomains("");
      setDiscoveryUrl("");
      setIsActive(true);
      setSavedAt(Date.now());
    } catch (err) {
      setError(describeFailure(err, runtimeCopy("m78e828adf24c")));
    } finally {
      setSaving(false);
    }
  }

  /* ── Loading skeleton ── */
  if (!hydrated || loading) {
    return (
      <div className="bv-dash min-h-screen bv-dash-shell">
        <div className="max-w-4xl mx-auto px-6 py-10">
          {/* breadcrumb skeleton */}
          <div className="flex items-center gap-2 mb-8">
            <div className="h-3 w-16 rounded animate-shimmer bg-surface-container-high" />
            <span className="material-symbols-outlined text-outline" style={{ fontSize: 14 }}>chevron_right</span>
            <div className="h-3 w-28 rounded animate-shimmer bg-surface-container-high" />
          </div>
          {/* card skeletons */}
          {[120, 96, 160].map((h, i) => (
            <div
              key={i}
              className="bv-glass rounded-2xl mb-4 animate-shimmer"
              style={{ height: h, background: "var(--color-surface-container-low)" }}
            />
          ))}
        </div>
      </div>
    );
  }

  /* ── Plan gate ── */
  if (planGate) {
    return (
      <div className="bv-dash min-h-screen bv-dash-shell">
        <div className="max-w-4xl mx-auto px-6 py-10 animate-fade-in">
          {/* breadcrumb */}
          <nav className="flex items-center gap-2 mb-8" aria-label={uiText("m58a52b30df2b")}>
            <Link
              href="/settings"
              className="bv-micro text-on-surface-variant hover:text-on-surface transition-colors"
              style={{ textTransform: "none", fontSize: 12, letterSpacing: 0 }}
            >{uiText("m17301d36c0f7")}</Link>
            <span className="material-symbols-outlined text-outline" style={{ fontSize: 14 }}>chevron_right</span>
            <span className="bv-micro text-on-surface" style={{ textTransform: "none", fontSize: 12, letterSpacing: 0 }}>
              {t("title")}
            </span>
          </nav>

          <div className="bv-glass rounded-2xl p-10 text-center max-w-lg mx-auto">
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-5"
              style={{ background: "rgba(59,130,246,0.10)", border: "1px solid rgba(59,130,246,0.20)" }}
            >
              <span className="material-symbols-outlined gradient-text" style={{ fontSize: 28 }}>workspace_premium</span>
            </div>
            <h1 className="bv-headline mb-3">{t("title")}</h1>
            <p className="bv-caption mb-6 max-w-sm mx-auto">{t("plan_gate_body")}</p>
            <Link
              href="/pricing"
              className="bv-btn bv-btn-primary inline-flex"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_upward</span>
              {t("plan_gate_cta")}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const callbackHint = tenantSlug
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/api/v1/auth/sso/${tenantSlug}/callback`
    : "";

  return (
    <div className="bv-dash min-h-screen bv-dash-shell">
      <div className="max-w-4xl mx-auto px-6 py-10 animate-fade-in bv-stagger">

        {/* ── Breadcrumb ── */}
        <nav className="flex items-center gap-2 mb-8" aria-label={uiText("m58a52b30df2b")}>
          <Link
            href="/settings"
            className="text-on-surface-variant hover:text-on-surface transition-colors"
            style={{ fontSize: 12 }}
          >{uiText("m17301d36c0f7")}</Link>
          <span className="material-symbols-outlined text-outline" style={{ fontSize: 14 }}>chevron_right</span>
          <span className="text-on-surface font-medium" style={{ fontSize: 12 }}>
            {t("title")}
          </span>
        </nav>

        {/* ── Page head ── */}
        <div className="bv-page-head mb-8">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: "rgba(59,130,246,0.12)", border: "1px solid rgba(59,130,246,0.20)" }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18, color: "var(--color-primary)" }}>
                  verified_user
                </span>
              </div>
              <h1 className="bv-headline">{t("title")}</h1>
            </div>
            <p className="bv-caption ml-12">{t("subtitle")}</p>
          </div>

          {/* Status pill */}
          {config && (
            <div className="flex items-center gap-2">
              <span
                className={`bv-dot ${config.isActive ? "bv-completed bv-ping" : "bv-paused"}`}
              />
              <span className="bv-caption">
                {config.isActive ? t("status_active") : t("status_inactive")}
              </span>
              {config.discoveredAt && (
                <span className="bv-micro" style={{ textTransform: "none", letterSpacing: 0, fontSize: 11 }}>
                  · {t("last_discovered", { when: formatDisplayDateTime(config.discoveredAt, displayLocale, { timeZone: displayTimeZone(), dateStyle: "medium", timeStyle: "short" }) })}
                </span>
              )}
            </div>
          )}
        </div>

        {/* ── Two-column layout ── */}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 340px", gap: 18, alignItems: "start" }}
          className="max-[900px]:!block">

          {/* ── Main form column ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

            {/* Issuer + Client ID card */}
            <div className="bv-glass rounded-2xl p-6">
              <p className="bv-micro mb-4" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>dns</span>{uiText("m04575c3aa05d")}</p>

              <form
                id="identity-form"
                onSubmit={(e) => { e.preventDefault(); save(); }}
                style={{ display: "flex", flexDirection: "column", gap: 14 }}
              >
                <ForgeField
                  label={t("issuer")}
                  hint={t("issuer_hint")}
                  value={issuer}
                  onChange={setIssuer}
                  placeholder="https://login.microsoftonline.com/{tenant}/v2.0"
                  required
                  icon="language"
                />
                <ForgeField
                  label={t("client_id")}
                  value={clientId}
                  onChange={setClientId}
                  required
                  icon="fingerprint"
                />
                <ForgeField
                  label={config ? t("client_secret_rotate") : t("client_secret")}
                  hint={config ? t("client_secret_hint_rotate") : t("client_secret_hint_new")}
                  value={clientSecret}
                  onChange={setClientSecret}
                  type="password"
                  required={!config}
                  icon="key"
                />
              </form>
            </div>

            {/* Callback + Scopes card */}
            <div className="bv-glass rounded-2xl p-6">
              <p className="bv-micro mb-4" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>route</span>{uiText("m4ac81f8d693d")}</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <ForgeField
                  label={t("redirect_uri")}
                  hint={callbackHint ? t("redirect_uri_hint", { url: callbackHint }) : t("redirect_uri_hint_generic")}
                  value={redirectUri}
                  onChange={setRedirectUri}
                  required
                  icon="reply"
                  form="identity-form"
                />
                <ForgeField
                  label={t("scopes")}
                  hint={t("scopes_hint")}
                  value={scopes}
                  onChange={setScopes}
                  icon="category"
                  form="identity-form"
                />
                <ForgeField
                  label={t("domains")}
                  hint={t("domains_hint")}
                  value={domains}
                  onChange={setDomains}
                  placeholder={uiText("m0980004c67c1")}
                  icon="alternate_email"
                  form="identity-form"
                />
                <ForgeField
                  label={t("discovery_url_optional")}
                  hint={t("discovery_url_hint")}
                  value={discoveryUrl}
                  onChange={setDiscoveryUrl}
                  placeholder="https://issuer.example/.well-known/openid-configuration"
                  icon="explore"
                  form="identity-form"
                />
              </div>
            </div>

            {/* Active toggle */}
            <div className="bv-glass rounded-2xl p-5">
              <label className="flex items-center justify-between gap-4 cursor-pointer">
                <div>
                  <p className="text-on-surface font-medium" style={{ fontSize: 13 }}>{t("active_toggle")}</p>
                  <p className="bv-caption mt-0.5">
                    {isActive ?uiText("m3af0642101f2") :uiText("m59f31e9a773e")}
                  </p>
                </div>
                {/* pill toggle */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={isActive}
                  onClick={() => setIsActive((v) => !v)}
                  className="flex-shrink-0 transition-all"
                  style={{
                    width: 44,
                    height: 24,
                    borderRadius: 999,
                    background: isActive
                      ? "linear-gradient(135deg,#3B82F6,#2563EB)"
                      : "rgba(255,255,255,0.08)",
                    border: "none",
                    cursor: "pointer",
                    position: "relative",
                    boxShadow: isActive ? "0 0 12px rgba(59,130,246,0.30)" : "none",
                  }}
                >
                  <div
                    className="absolute top-[3px] h-[18px] w-[18px] rounded-full transition-all"
                    style={{
                      background: "white",
                      left: isActive ? "calc(100% - 21px)" : "3px",
                      boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
                    }}
                  />
                </button>
              </label>
            </div>

            {/* Error / success banners */}
            {error && (
              <div
                role="alert"
                className="flex items-start gap-3 rounded-xl px-4 py-3"
                style={{
                  background: "rgba(255,77,77,0.08)",
                  border: "1px solid rgba(255,77,77,0.25)",
                  color: "#FF8A8A",
                  fontSize: 13,
                }}
              >
                <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 18, color: "#FF4D4D", marginTop: 1 }}>error</span>
                <span>{error}</span>
              </div>
            )}
            {savedAt && !error && (
              <div
                role="status"
                className="flex items-center gap-3 rounded-xl px-4 py-3"
                style={{
                  background: "rgba(59,130,246,0.08)",
                  border: "1px solid rgba(59,130,246,0.20)",
                  color: "var(--color-primary)",
                  fontSize: 13,
                }}
              >
                <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 18, color: "#3B82F6" }}>check_circle</span>
                <span>{t("saved")}</span>
              </div>
            )}

            {/* Action bar */}
            <div className="flex items-center gap-3 flex-wrap">
              <button
                type="submit"
                form="identity-form"
                disabled={saving}
                className="bv-btn bv-btn-primary"
                style={{ opacity: saving ? 0.7 : 1 }}
              >
                {saving ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />{uiText("m1324795a7aa8")}</>
                ) : (
                  <>
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>save</span>
                    {t("save")}
                  </>
                )}
              </button>

              {config && tenantSlug && (
                <a
                  href={`/api/v1/auth/sso/${tenantSlug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="bv-btn bv-btn-ghost"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>open_in_new</span>
                  {t("test_sign_in")}
                </a>
              )}

              {config && (
                <button
                  type="button"
                  onClick={disconnect}
                  disabled={saving}
                  className="bv-btn bv-btn-danger ml-auto"
                  style={{ opacity: saving ? 0.5 : 1 }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>link_off</span>
                  {t("disconnect")}
                </button>
              )}
            </div>
          </div>

          {/* ── Sticky side rail ── */}
          <div style={{ position: "sticky", top: 84, display: "flex", flexDirection: "column", gap: 16 }}>

            {/* Connection status card */}
            <div className="bv-glass rounded-2xl p-5">
              <p className="bv-micro mb-4" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className={`bv-dot ${config?.isActive ? "bv-completed bv-ping" : "bv-paused"}`} />{uiText("m17cc90014b3e")}</p>

              <div
                className="rounded-xl p-4"
                style={{
                  background: "var(--color-surface-container-low)",
                  border: "1px solid rgba(255,255,255,0.05)",
                }}
              >
                <span className="bv-mono block mb-3" style={{ fontSize: 10, color: "var(--color-outline)" }}>{uiText("m90bd8874ada5")}{" "}{config ?uiText("m1995887ad355") :uiText("mb5610055f059")}
                </span>

                {[
                  { label: runtimeCopy("m1368805fe919"), val: issuer || "—" },
                  { label: runtimeCopy("mb525865201ae"), val: clientId ? `${clientId.slice(0, 8)}…` : "—" },
                  { label: runtimeCopy("ma2a8e033d138"), val: redirectUri ?uiText("ma388b35eeee6") : "—" },
                  { label: runtimeCopy("m092455f07cd1"), val: scopes || "—" },
                ].map(({ label, val }) => (
                  <div
                    key={label}
                    className="flex justify-between items-center py-2"
                    style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                  >
                    <span className="bv-mono" style={{ fontSize: 10, color: "var(--color-outline)" }}>{label}</span>
                    <span
                      className="bv-mono truncate max-w-[140px] text-right"
                      style={{ fontSize: 10, color: "var(--color-on-surface-variant)" }}
                      title={val}
                    >
                      {val}
                    </span>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2 mt-4">
                <span
                  className={`bv-dot ${config?.isActive ? "bv-completed" : "bv-paused"}`}
                  style={{ width: 6, height: 6 }}
                />
                <span className="bv-caption">
                  {config?.isActive
                    ?uiText("m1be41d5fc4dd")
                    : config
                    ?uiText("m5eb5faa6cbf5")
                    :uiText("m9a52affa6218")}
                </span>
              </div>
            </div>

            {/* Callback hint */}
            {callbackHint && (
              <div className="bv-glass rounded-2xl p-5">
                <p className="bv-micro mb-3" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>info</span>{uiText("m99463116beca")}</p>
                <p className="bv-caption mb-3">{uiText("mc5038b20a0d6")}</p>
                <div
                  className="rounded-lg px-3 py-2.5 flex items-center gap-2"
                  style={{
                    background: "var(--color-surface-container-low)",
                    border: "1px solid rgba(255,255,255,0.06)",
                  }}
                >
                  <code
                    className="bv-mono flex-1 truncate"
                    style={{ fontSize: 10, color: "var(--color-on-surface-variant)", wordBreak: "break-all" }}
                  >
                    {callbackHint}
                  </code>
                  <button
                    type="button"
                    className="bv-btn bv-btn-ghost bv-btn-icon flex-shrink-0"
                    onClick={() => navigator.clipboard.writeText(callbackHint)}
                    title={uiText("m4f8f4a6029d8")}
                    style={{ minHeight: 28, padding: "4px 6px" }}
                   aria-label={uiText("m4f8f4a6029d8")}>
                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>content_copy</span>
                  </button>
                </div>
              </div>
            )}

            {/* Info box */}
            <div
              className="rounded-2xl p-5"
              style={{
                background: "rgba(59,130,246,0.05)",
                border: "1px solid rgba(59,130,246,0.12)",
              }}
            >
              <div className="flex items-center gap-2 mb-3">
                <span className="material-symbols-outlined" style={{ fontSize: 16, color: "var(--color-primary)" }}>
                  shield
                </span>
                <span className="bv-micro" style={{ color: "var(--color-primary)" }}>{t("enterprise_sso")}</span>
              </div>
              <p className="bv-caption">{uiText("m1e939b7b4cbc")}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── ForgeField — FORGE-styled form field ── */
function ForgeField(props: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
  icon?: string;
  form?: string;
}) {
  const [focused, setFocused] = useState(false);

  return (
    <label style={{ display: "block" }}>
      <div
        className="flex items-center gap-1.5 mb-1.5"
        style={{ fontSize: 10, color: "var(--color-outline)", textTransform: "uppercase", letterSpacing: "0.06em" }}
      >
        {props.icon && (
          <span className="material-symbols-outlined" style={{ fontSize: 12, color: "var(--color-outline)" }}>
            {props.icon}
          </span>
        )}
        {props.label}
        {props.required && (
          <span style={{ color: "var(--color-error)", marginInlineStart: 2 }}>*</span>
        )}
      </div>
      <div
        className="flex items-center gap-2 rounded-xl transition-all"
        style={{
          background: "var(--color-surface-container-low)",
          border: `1px solid ${focused ? "rgba(59,130,246,0.45)" : "rgba(255,255,255,0.07)"}`,
          boxShadow: focused ? "0 0 0 3px rgba(59,130,246,0.10)" : "none",
          paddingInlineStart: 12,
          paddingInlineEnd: 12,
        }}
      >
        <input
          type={props.type ?? "text"}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder={props.placeholder}
          required={props.required}
          form={props.form}
          autoComplete={props.type === "password" ? "new-password" : "off"}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            color: "var(--color-on-surface)",
            fontSize: 13,
            fontFamily: props.type === "password" ? "var(--bv-font-mono)" : "inherit",
            paddingTop: 10,
            paddingBottom: 10,
            minHeight: 40,
          }}
        />
      </div>
      {props.hint && (
        <p className="bv-caption mt-1.5" style={{ fontSize: 11 }}>{props.hint}</p>
      )}
    </label>
  );
}

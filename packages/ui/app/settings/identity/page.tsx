"use client";

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
        setError(msg);
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
      setError(err instanceof Error ? err.message : "Save failed");
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
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setSaving(false);
    }
  }

  if (!hydrated || loading) {
    return (
      <main style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
        <div style={{ color: "var(--color-outline)", fontSize: 13 }}>{t("loading")}</div>
      </main>
    );
  }

  if (planGate) {
    return (
      <main style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
        <Link href="/settings" style={{ fontSize: 12, color: "var(--color-outline)" }}>
          ← {t("back")}
        </Link>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginTop: 8 }}>{t("title")}</h1>
        <p style={{ fontSize: 13, color: "var(--color-on-surface-variant)", marginTop: 8, maxWidth: 480 }}>
          {t("plan_gate_body")}
        </p>
        <Link
          href="/pricing"
          style={{
            display: "inline-block",
            marginTop: 16,
            padding: "10px 16px",
            background: "var(--color-primary-container, #00d1ff)",
            color: "#000",
            borderRadius: 10,
            fontSize: 13,
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          {t("plan_gate_cta")}
        </Link>
      </main>
    );
  }

  const callbackHint = tenantSlug
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/api/v1/auth/sso/${tenantSlug}/callback`
    : "";

  return (
    <main style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
      <Link href="/settings" style={{ fontSize: 12, color: "var(--color-outline)" }}>
        ← {t("back")}
      </Link>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginTop: 8 }}>{t("title")}</h1>
      <p style={{ fontSize: 13, color: "var(--color-on-surface-variant)", marginTop: 4 }}>
        {t("subtitle")}
      </p>

      {/* Status pill */}
      {config && (
        <div style={{ marginTop: 16, display: "flex", gap: 8, alignItems: "center" }}>
          <span
            style={{
              padding: "4px 10px",
              borderRadius: 999,
              fontSize: 11,
              background: config.isActive ? "rgba(52,211,153,0.12)" : "rgba(133,147,153,0.12)",
              color: config.isActive ? "#34d399" : "#859399",
              border: `1px solid ${config.isActive ? "rgba(52,211,153,0.25)" : "rgba(133,147,153,0.25)"}`,
            }}
          >
            {config.isActive ? t("status_active") : t("status_inactive")}
          </span>
          {config.discoveredAt && (
            <span style={{ fontSize: 11, color: "var(--color-outline)" }}>
              {t("last_discovered", { when: new Date(config.discoveredAt).toLocaleString() })}
            </span>
          )}
        </div>
      )}

      {/* Form */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 14 }}
      >
        <Field
          label={t("issuer")}
          hint={t("issuer_hint")}
          value={issuer}
          onChange={setIssuer}
          placeholder="https://login.microsoftonline.com/{tenant}/v2.0"
          required
        />
        <Field
          label={t("client_id")}
          value={clientId}
          onChange={setClientId}
          required
        />
        <Field
          label={config ? t("client_secret_rotate") : t("client_secret")}
          hint={config ? t("client_secret_hint_rotate") : t("client_secret_hint_new")}
          value={clientSecret}
          onChange={setClientSecret}
          type="password"
          required={!config}
        />
        <Field
          label={t("redirect_uri")}
          hint={callbackHint ? t("redirect_uri_hint", { url: callbackHint }) : t("redirect_uri_hint_generic")}
          value={redirectUri}
          onChange={setRedirectUri}
          required
        />
        <Field
          label={t("scopes")}
          hint={t("scopes_hint")}
          value={scopes}
          onChange={setScopes}
        />
        <Field
          label={t("domains")}
          hint={t("domains_hint")}
          value={domains}
          onChange={setDomains}
          placeholder="acme.com, acme-contractors.com"
        />
        <Field
          label={t("discovery_url_optional")}
          hint={t("discovery_url_hint")}
          value={discoveryUrl}
          onChange={setDiscoveryUrl}
          placeholder="https://issuer.example/.well-known/openid-configuration"
        />
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "var(--color-on-surface-variant)" }}>
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
          />
          {t("active_toggle")}
        </label>

        {error && (
          <div role="alert" style={{ fontSize: 12, color: "#f87171" }}>
            {error}
          </div>
        )}
        {savedAt && !error && (
          <div role="status" style={{ fontSize: 12, color: "#34d399" }}>
            {t("saved")}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <button
            type="submit"
            disabled={saving}
            style={{
              padding: "10px 16px",
              background: "var(--color-primary-container, #00d1ff)",
              color: "#000",
              border: "none",
              borderRadius: 10,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              minHeight: 40,
            }}
          >
            {saving ? "…" : t("save")}
          </button>
          {config && tenantSlug && (
            <a
              href={`/api/v1/auth/sso/${tenantSlug}`}
              target="_blank"
              rel="noreferrer"
              style={{
                padding: "10px 16px",
                background: "transparent",
                color: "var(--color-on-surface)",
                border: "1px solid rgba(255,255,255,0.10)",
                borderRadius: 10,
                fontSize: 13,
                textDecoration: "none",
                minHeight: 40,
                display: "inline-flex",
                alignItems: "center",
              }}
            >
              {t("test_sign_in")}
            </a>
          )}
          {config && (
            <button
              type="button"
              onClick={disconnect}
              disabled={saving}
              style={{
                padding: "10px 16px",
                background: "rgba(248,113,113,0.10)",
                color: "#f87171",
                border: "1px solid rgba(248,113,113,0.25)",
                borderRadius: 10,
                fontSize: 13,
                cursor: "pointer",
                marginLeft: "auto",
                minHeight: 40,
              }}
            >
              {t("disconnect")}
            </button>
          )}
        </div>
      </form>
    </main>
  );
}

function Field(props: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <label style={{ display: "block" }}>
      <div style={{ fontSize: 11, color: "var(--color-outline)", marginBottom: 4, textTransform: "uppercase", letterSpacing: 1 }}>
        {props.label}
        {props.required && <span style={{ color: "#f87171", marginLeft: 4 }}>*</span>}
      </div>
      <input
        type={props.type ?? "text"}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        required={props.required}
        autoComplete={props.type === "password" ? "new-password" : "off"}
        style={{
          width: "100%",
          padding: "10px 12px",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.10)",
          borderRadius: 10,
          color: "var(--color-on-surface)",
          fontSize: 13,
          fontFamily: props.type === "password" ? "monospace" : "inherit",
          minHeight: 40,
        }}
      />
      {props.hint && (
        <div style={{ fontSize: 11, color: "var(--color-outline)", marginTop: 4 }}>{props.hint}</div>
      )}
    </label>
  );
}

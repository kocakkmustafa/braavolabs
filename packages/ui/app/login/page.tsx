"use client";
import { useTranslations as useLegacyTranslations } from "next-intl";


import { useState, useEffect, useId, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { apiFetch, api, ApiRequestError } from "../../lib/api";
import { authErrorKey } from "../../lib/auth-errors";
import { captureAuthSession, isAuthSessionCurrent, useAppStore } from "../../lib/store";
import LanguageSwitcher from "../../components/LanguageSwitcher";

export default function LoginPage() {
  const uiText = useLegacyTranslations("uiCopy");
  const t = useTranslations();
  const router = useRouter();
  const token = useAppStore((s) => s.token);
  const hydrated = useAppStore((s) => s._hydrated);
  const setAuth = useAppStore((s) => s.setAuth);
  const mounted = useRef(true);
  const formOwnsNavigation = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // ?tab=register lets /register (and any external link/email) deep-link
  // into the sign-up tab. We read window.location.search directly rather
  // than useSearchParams() — Next 15 requires the latter to be wrapped
  // in a Suspense boundary at build time, which would force a larger
  // refactor for a one-line query check. window.location is safe inside
  // 'use client' since it's only evaluated in the browser.
  const [mode, setMode] = useState<"login" | "register">("login");
  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("tab") === "register") setMode("register");
    }
  }, []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pwStrength, setPwStrength] = useState(0);
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotStatus, setForgotStatus] = useState<"idle" | "loading" | "sent" | "error">("idle");
  const [forgotError, setForgotError] = useState<string | null>(null);

  useEffect(() => {
    // router.replace, NOT push — see comment block above for why.
    if (hydrated && token && !formOwnsNavigation.current) router.replace("/dashboard");
  }, [hydrated, token, router]);

  useEffect(() => {
    if (!password) { setPwStrength(0); return; }
    let s = 0;
    if (password.length >= 8) s++;
    if (/[A-Z]/.test(password)) s++;
    if (/[0-9]/.test(password)) s++;
    if (/[^A-Za-z0-9]/.test(password)) s++;
    setPwStrength(s);
  }, [password]);

  function validate(): string | null {
    if (!email.trim()) return t("auth.validation.emailRequired");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return t("auth.validation.emailInvalid");
    if (!password) return t("auth.validation.passwordRequired");
    if (password.length < 8) return t("auth.validation.passwordMin");
    if (mode === "register") {
      if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(password)) {
        return t("auth.validation.passwordRegex");
      }
      if (!name.trim()) return t("auth.validation.nameRequired");
      if (!tenantName.trim()) return t("auth.validation.orgRequired");
    }
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const session = captureAuthSession();
    const stillOwnsResult = () => mounted.current && isAuthSessionCurrent(session);
    if (!stillOwnsResult()) return;
    const validationError = validate();
    if (validationError) { setError(validationError); return; }
    setError(null);
    setLoading(true);
    try {
      if (mode === "login") {
        const res = await apiFetch<{ token: string; refreshToken: string; user: any; tenant: any }>(
          "/auth/login",
          { method: "POST", body: JSON.stringify({ email, password }) },
        );
        if (!stillOwnsResult()) return;
        formOwnsNavigation.current = true;
        setAuth(res.token, res.tenant.id, res.refreshToken);
        router.replace("/dashboard");
      } else {
        const res = await apiFetch<{ token: string; refreshToken: string; user: any; tenant: any }>(
          "/auth/register",
          {
            method: "POST",
            body: JSON.stringify({ email, password, name, tenantName, ...(ref && { ref }) }),
          },
        );
        if (!stillOwnsResult()) return;
        formOwnsNavigation.current = true;
        setAuth(res.token, res.tenant.id, res.refreshToken);
        router.replace("/onboarding");
      }
    } catch (err) {
      if (!stillOwnsResult()) return;
      setError(t(authErrorKey(err, { credentials: mode === "login" })));
    } finally {
      if (stillOwnsResult()) setLoading(false);
    }
  }

  const strengthColors = [
    "bg-red-500",
    "bg-orange-500",
    "bg-yellow-500",
    "bg-emerald-500",
  ];
  const strengthKeys = ["weak", "fair", "good", "strong"] as const;

  return (
    <div
      className="bv-auth-entry bv-mesh relative grid min-h-dvh grid-cols-1 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,.95fr)]"
    >
      {/* ── Left cinematic panel ─────────────────────────────── */}
      <div
        className="hidden min-w-0 lg:flex flex-col justify-between relative overflow-hidden"
        style={{ padding: "44px", borderInlineEnd: "1px solid var(--bv-steel-shadow)" }}
      >
        {/* Halo orb behind emblem */}
        <div
          className="absolute animate-pulse-glow"
          style={{
            inset: 0,
            display: "grid",
            placeItems: "center",
            zIndex: 1,
            pointerEvents: "none",
          }}
        >
          <div style={{ position: "relative", width: "min(58%, 360px)", aspectRatio: "1" }}>
            <div
              style={{
                position: "absolute",
                inset: "-16%",
                borderRadius: "50%",
                background: "radial-gradient(circle, rgba(59,130,246,.4), rgba(59,130,246,.1) 40%, transparent 68%)",
                filter: "blur(12px)",
                animation: "bv-pulse-glow 5s ease-in-out infinite",
              }}
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/braavolabs-logo.png"
              alt=""
              className="animate-float"
              style={{
                position: "relative",
                zIndex: 2,
                width: "100%",
                height: "100%",
                objectFit: "contain",
                WebkitMaskImage: "radial-gradient(circle, #000 70%, transparent 80%)",
                maskImage: "radial-gradient(circle, #000 70%, transparent 80%)",
                filter: "drop-shadow(0 12px 30px rgba(0,0,0,.7)) drop-shadow(0 0 26px rgba(59,130,246,.35))",
              }}
            />
          </div>
        </div>

        {/* Logo lockup */}
        <a
          href="/"
          className="relative flex items-center gap-3"
          style={{ zIndex: 3, textDecoration: "none" }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/braavolabs-logo.png"
            alt="Braavolabs"
            style={{ width: 34, height: 34, borderRadius: "50%" }}
          />
          <span
            className="font-headline font-bold text-base"
            style={{ color: "var(--color-on-surface)" }}
          >
            Braavolabs
          </span>
        </a>

        {/* Localized workspace identity; no delivery or pricing promise. */}
        <div
          className="relative"
          style={{
            zIndex: 3,
            fontFamily: "var(--bv-font-display)",
            fontSize: "clamp(22px, 2.4vw, 32px)",
            fontWeight: 500,
            textTransform: "uppercase",
            letterSpacing: "-0.01em",
            lineHeight: 1.1,
            maxWidth: "16ch",
            minHeight: "2.4em",
            transition: "opacity 0.4s",
            color: "var(--color-on-surface)",
          }}
        >
          {t("auth.hero.title")}
        </div>
      </div>

      {/* ── Right form panel ─────────────────────────────────── */}
      <div
        className="flex min-w-0 items-center justify-center"
        style={{ padding: "clamp(16px, 3vw, 44px)", minHeight: "100dvh" }}
      >
        <div className="bv-glass bv-rise" style={{ width: "100%", maxWidth: 420, minWidth: 0, padding: "clamp(20px, 3vw, 36px)" }}>
          <div className="flex justify-end mb-4">
            <LanguageSwitcher />
          </div>
          {/* Mobile logo */}
          <a
            href="/"
            className="lg:hidden flex items-center gap-3 mb-6"
            style={{ textDecoration: "none" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/braavolabs-logo.png"
              alt="Braavolabs"
              style={{ width: 30, height: 30, borderRadius: "50%" }}
            />
            <span
              className="font-headline font-bold text-sm"
              style={{ color: "var(--color-on-surface)" }}
            >
              Braavolabs
            </span>
          </a>

          <h1
            className="bv-display"
            style={{ textTransform: "uppercase", marginBottom: 6 }}
          >
            {mode === "login" ? t("auth.login.welcome") : t("auth.register.welcome")}
          </h1>
          <p className="bv-caption" style={{ marginBottom: 24, fontSize: 15 }}>
            {mode === "login" ? t("auth.login.subtitle") : t("auth.register.subtitle")}
          </p>

          {/* Tab toggle */}
          <div
            className="flex p-1 rounded-xl mb-6"
            style={{
              background: "rgba(255,255,255,0.04)",
              border: "1px solid var(--bv-glass-border)",
            }}
          >
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setError(null); }}
                className="flex-1 py-2 rounded-lg text-sm font-semibold transition-all"
                style={{
                  background: mode === m ? "rgba(59,130,246,0.12)" : "transparent",
                  color: mode === m ? "var(--color-on-surface)" : "var(--color-outline)",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                {m === "login" ? t("auth.login.tabSignIn") : t("auth.login.tabRegister")}
              </button>
            ))}
          </div>

          {/* Error banner */}
          {error && (
            <div
              role="alert"
              className="flex items-center gap-2 mb-4 px-4 py-3 rounded-xl text-sm bv-mono"
              style={{
                background: "rgba(255,77,77,.08)",
                border: "1px solid rgba(255,77,77,.3)",
                color: "var(--bv-status-failed)",
              }}
            >
              <span className="bv-dot bv-failed bv-ping" />
              {error}
            </div>
          )}

          {/* OAuth buttons */}
          <div className="grid grid-cols-1 min-[480px]:grid-cols-3 gap-3" style={{ marginBottom: 22 }}>
            {/* Apple */}
            <button
              type="button"
              onClick={async () => {
                try {
                  const { url } = await api.appleAuthUrl();
                  window.location.href = url;
                } catch (err) {
                  const msg = err instanceof Error ? err.message : "";
                  if ((err instanceof ApiRequestError && err.status === 503) || msg.includes("not configured")) {
                    setError(t("auth.oauth.appleNotConfigured"));
                  } else if (msg.includes("fetch") || msg.includes("Failed") || msg.includes("ECONNREFUSED")) {
                    setError(t("auth.oauth.cannotConnect"));
                  } else {
                    setError(t("auth.oauth.appleFailed"));
                  }
                }
              }}
              className="bv-btn bv-btn-ghost flex items-center justify-center gap-2"
              style={{ fontSize: 14, minWidth: 0, padding: "10px 8px" }}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
              </svg>{uiText("m7801df791ac5")}</button>
            {/* Google */}
            <button
              type="button"
              onClick={async () => {
                try {
                  const { url } = await api.googleAuthUrl();
                  window.location.href = url;
                } catch (err) {
                  const msg = err instanceof Error ? err.message : "";
                  if ((err instanceof ApiRequestError && err.status === 503) || msg.includes("not configured")) {
                    setError(t("auth.oauth.googleNotConfigured"));
                  } else if (msg.includes("fetch") || msg.includes("Failed") || msg.includes("ECONNREFUSED")) {
                    setError(t("auth.oauth.cannotConnect"));
                  } else {
                    setError(t("auth.oauth.googleFailed"));
                  }
                }
              }}
              className="bv-btn bv-btn-ghost flex items-center justify-center gap-2"
              style={{ fontSize: 14, minWidth: 0, padding: "10px 8px" }}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>{uiText("m3e059886391a")}</button>
            {/* GitHub */}
            <button
              type="button"
              onClick={async () => {
                try {
                  const { url } = await api.githubAuthUrl();
                  window.location.href = url;
                } catch (err) {
                  const msg = err instanceof Error ? err.message : "";
                  if ((err instanceof ApiRequestError && err.status === 503) || msg.includes("not configured")) {
                    setError(t("auth.oauth.githubNotConfigured"));
                  } else if (msg.includes("fetch") || msg.includes("Failed") || msg.includes("ECONNREFUSED")) {
                    setError(t("auth.oauth.cannotConnect"));
                  } else {
                    setError(t("auth.oauth.githubFailed"));
                  }
                }
              }}
              className="bv-btn bv-btn-ghost flex items-center justify-center gap-2"
              style={{ fontSize: 14, minWidth: 0, padding: "10px 8px" }}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 .5A11.5 11.5 0 0 0 .5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.17c-3.2.7-3.87-1.36-3.87-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.75 1.18 1.75 1.18 1.02 1.74 2.67 1.24 3.32.95.1-.74.4-1.24.72-1.53-2.55-.29-5.24-1.27-5.24-5.66 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.15 1.17a10.94 10.94 0 0 1 5.74 0c2.19-1.48 3.15-1.17 3.15-1.17.62 1.58.23 2.75.11 3.04.74.8 1.18 1.82 1.18 3.07 0 4.4-2.69 5.36-5.26 5.65.41.36.78 1.06.78 2.13v3.16c0 .31.21.67.8.55A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5z" />
              </svg>{uiText("m75ecaff6a037")}</button>
          </div>

          {/* Divider */}
          <div className="flex items-center my-5 gap-4">
            <div className="bv-divider flex-1" />
            <span className="bv-micro">{t("auth.oauth.divider")}</span>
            <div className="bv-divider flex-1" />
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }} noValidate>
            {mode === "register" && (
              <>
                <ForgeField label={t("auth.fields.fullName")} type="text" value={name} onChange={setName} placeholder={t("auth.fields.fullNamePlaceholder")} required />
                <ForgeField label={t("auth.fields.organization")} type="text" value={tenantName} onChange={setTenantName} placeholder={t("auth.fields.organizationPlaceholder")} required />
              </>
            )}

            <ForgeField label={t("auth.fields.email")} type="email" value={email} onChange={setEmail} placeholder={t("auth.fields.emailPlaceholder")} required />

            <div>
              <ForgeField
                label={t("auth.fields.password")}
                type="password"
                value={password}
                onChange={setPassword}
                placeholder={mode === "register" ? t("auth.fields.passwordRegisterPlaceholder") : t("auth.fields.passwordLoginPlaceholder")}
                required
                minLength={8}
              />
              {mode === "login" && (
                <div className="flex justify-end mt-1.5">
                  <button
                    type="button"
                    onClick={() => setShowForgot(true)}
                    style={{
                      color: "var(--color-primary)",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      padding: 0,
                      fontSize: 13,
                    }}
                  >
                    {t("auth.forgot.link")}
                  </button>
                </div>
              )}
              {mode === "register" && password && (
                <div style={{ marginTop: 8 }}>
                  <div className="flex gap-1 mb-1">
                    {[0, 1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className={`flex-1 h-1 rounded-full transition-all duration-300 ${i < pwStrength ? strengthColors[pwStrength - 1] : ""}`}
                        style={i >= pwStrength ? { background: "rgba(255,255,255,0.06)" } : {}}
                      />
                    ))}
                  </div>
                  {pwStrength > 0 && (
                    <p className="bv-caption">
                      {t("auth.strength.label")}{" "}
                      <span style={{ color: "var(--color-on-surface-variant)" }}>
                        {t(`auth.strength.${strengthKeys[pwStrength - 1]}`)}
                      </span>
                    </p>
                  )}
                </div>
              )}
            </div>

            {mode === "register" && (
              <ForgeField
                label={t("auth.fields.referralCode")}
                type="text"
                value={ref}
                onChange={setRef}
                placeholder={t("auth.fields.referralCodePlaceholder")}
                optional
                optionalLabel={t("auth.fields.optional")}
              />
            )}

            <button
              type="submit"
              disabled={loading}
              className="bv-btn bv-btn-primary w-full"
              style={{ marginTop: 4, padding: "13px 20px", fontSize: 14, borderRadius: 12 }}
            >
              {loading
                ? t("auth.submit.loading")
                : mode === "login"
                  ? t("auth.submit.signIn")
                  : t("auth.submit.createAccount")}
            </button>
          </form>

          {/* Footer */}
          <p className="bv-caption" style={{ textAlign: "center", marginTop: 24, fontSize: 14 }}>
            {mode === "login" ? (
              <>
                {t("auth.login.newHere")}{" "}
                <button
                  type="button"
                  onClick={() => { setMode("register"); setError(null); }}
                  style={{ color: "var(--color-primary)", background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: "inherit" }}
                >
                  {t("auth.login.tabRegister")}
                </button>
              </>
            ) : (
              <>
                {t("auth.register.hasAccount")}{" "}
                <button
                  type="button"
                  onClick={() => { setMode("login"); setError(null); }}
                  style={{ color: "var(--color-primary)", background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: "inherit" }}
                >
                  {t("auth.login.tabSignIn")}
                </button>
              </>
            )}
          </p>

          {/* Workspace slug-based SSO entry; configuration is server-owned. */}
          <details style={{ marginTop: 16 }}>
            <summary className="bv-micro" style={{ cursor: "pointer" }}>
              {t("auth.oauth.ssoToggle")}
            </summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const slug = (new FormData(e.currentTarget).get("slug") as string ?? "").trim();
                if (!slug) return;
                window.location.href = `/api/v1/auth/sso/${encodeURIComponent(slug)}`;
              }}
              style={{ display: "flex", gap: 6, marginTop: 8 }}
            >
              <input
                name="slug"
                placeholder={t("auth.oauth.ssoSlugPlaceholder")}
                aria-label={t("auth.oauth.ssoSlugPlaceholder")}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: "8px 10px",
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid var(--bv-glass-border)",
                  borderRadius: 10,
                  color: "var(--color-on-surface)",
                  fontSize: 13,
                  minHeight: 38,
                  outline: "none",
                }}
              />
              <button
                type="submit"
                className="bv-btn bv-btn-ghost bv-btn-sm"
                style={{ fontSize: 13, minHeight: 38 }}
              >
                {t("auth.oauth.ssoSubmit")}
              </button>
            </form>
          </details>
        </div>
      </div>

      {/* ── Forgot Password Modal ─────────────────────────────── */}
      {showForgot && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
        >
          <div className="bv-glass bv-rise" style={{ width: "100%", maxWidth: 400, padding: 24 }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="bv-title">{t("auth.forgot.modalTitle")}</h3>
              <button
                aria-label={t("auth.forgot.backToLogin")}
                onClick={() => { setShowForgot(false); setForgotStatus("idle"); setForgotError(null); setForgotEmail(""); }}
                className="bv-btn bv-btn-ghost bv-btn-icon"
                style={{ color: "var(--color-outline)" }}
              >
                <span className="material-symbols-outlined text-xl">close</span>
              </button>
            </div>

            {forgotStatus === "sent" ? (
              <div className="text-center py-4">
                <span
                  className="material-symbols-outlined block mb-3"
                  style={{ fontSize: 40, color: "var(--color-primary)" }}
                >
                  mark_email_read
                </span>
                <p className="font-semibold mb-1" style={{ color: "var(--color-on-surface)" }}>
                  {t("auth.forgot.successTitle")}
                </p>
                <p className="bv-caption">{t("auth.forgot.successDesc")}</p>
                <button
                  onClick={() => { setShowForgot(false); setForgotStatus("idle"); setForgotEmail(""); }}
                  className="bv-caption mt-4"
                  style={{ color: "var(--color-primary)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
                >
                  {t("auth.forgot.backToLogin")}
                </button>
              </div>
            ) : (
              <>
                <p className="bv-caption mb-4">{t("auth.forgot.modalDesc")}</p>
                {forgotError && (
                  <div
                    role="alert"
                    className="px-3 py-2 rounded-xl mb-3 bv-caption"
                    style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "var(--color-error)" }}
                  >
                    {forgotError}
                  </div>
                )}
                <input
                  type="email"
                  aria-label={t("auth.fields.email")}
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                  placeholder={t("auth.fields.emailPlaceholder")}
                  style={{
                    width: "100%",
                    padding: "10px 14px",
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid var(--bv-glass-border)",
                    borderRadius: 12,
                    color: "var(--color-on-surface)",
                    fontSize: 14,
                    outline: "none",
                    marginBottom: 12,
                    boxSizing: "border-box",
                  }}
                />
                <button
                  onClick={async () => {
                    if (!forgotEmail.trim()) return;
                    setForgotStatus("loading");
                    setForgotError(null);
                    try {
                      await api.forgotPassword(forgotEmail.trim());
                      setForgotStatus("sent");
                    } catch (err) {
                      setForgotStatus("error");
                      setForgotError(t(authErrorKey(err)));
                    }
                  }}
                  disabled={forgotStatus === "loading" || !forgotEmail.trim()}
                  className="bv-btn bv-btn-primary w-full"
                  style={{ border: "none", cursor: "pointer", padding: "11px 20px", fontSize: 14 }}
                >
                  {forgotStatus === "loading" ? t("auth.forgot.loading") : t("auth.forgot.submit")}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ForgeField({
  label, type, value, onChange, placeholder, required, optional, optionalLabel, minLength,
}: {
  label: string; type: string; value: string; onChange: (v: string) => void;
  placeholder: string; required?: boolean; optional?: boolean; optionalLabel?: string; minLength?: number;
}) {
  const uiText = useLegacyTranslations("uiCopy");
  const id = useId();
  return (
    <div>
      <label
        htmlFor={id}
        className="block bv-caption font-semibold"
        style={{ marginBottom: 6, color: "var(--color-on-surface-variant)" }}
      >
        {label}
        {optional && (
          <span className="font-normal ml-1" style={{ color: "var(--color-outline)" }}>
            {optionalLabel ??uiText("ma642566b6fb9")}
          </span>
        )}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        minLength={minLength}
        placeholder={placeholder}
        style={{
          width: "100%",
          padding: "10px 14px",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid var(--bv-glass-border)",
          borderRadius: 12,
          color: "var(--color-on-surface)",
          fontSize: 14,
          outline: "none",
          transition: "border-color 200ms, box-shadow 200ms",
          boxSizing: "border-box",
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = "rgba(59,130,246,0.5)";
          e.currentTarget.style.boxShadow = "0 0 0 3px rgba(59,130,246,0.08)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = "var(--bv-glass-border)";
          e.currentTarget.style.boxShadow = "none";
        }}
      />
    </div>
  );
}

"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { apiFetch, api } from "../../lib/api";
import { useAppStore } from "../../lib/store";

/**
 * /register — standalone FORGE-styled sign-up page.
 *
 * Split-screen layout (left brand panel / right form card) matching
 * the Braavolabs FORGE design system. All auth logic is identical to
 * the register branch in /login/page.tsx so both entry-points share
 * the same behaviour.
 */
export default function RegisterPage() {
  const t = useTranslations();
  const router = useRouter();
  const token = useAppStore((s) => s.token);
  const hydrated = useAppStore((s) => s._hydrated);
  const setAuth = useAppStore((s) => s.setAuth);

  const [name, setName] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [ref, setRef] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pwStrength, setPwStrength] = useState(0);

  // Pre-fill referral code from ?ref= query param
  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const r = params.get("ref");
      if (r) setRef(r);
    }
  }, []);

  // Redirect authenticated users
  useEffect(() => {
    if (hydrated && token) router.replace("/dashboard");
  }, [hydrated, token, router]);

  // Password strength meter
  useEffect(() => {
    if (!password) { setPwStrength(0); return; }
    let s = 0;
    if (password.length >= 8) s++;
    if (/[A-Z]/.test(password) && /[a-z]/.test(password)) s++;
    if (/\d/.test(password)) s++;
    if (/[^A-Za-z0-9]/.test(password)) s++;
    setPwStrength(Math.min(s, 4));
  }, [password]);

  function validate(): string | null {
    if (!name.trim()) return t("auth.validation.nameRequired");
    if (!tenantName.trim()) return t("auth.validation.orgRequired");
    if (!email.trim()) return t("auth.validation.emailRequired");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return t("auth.validation.emailInvalid");
    if (!password) return t("auth.validation.passwordRequired");
    if (password.length < 8) return t("auth.validation.passwordMin");
    if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(password)) return t("auth.validation.passwordRegex");
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validationError = validate();
    if (validationError) { setError(validationError); return; }
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; refreshToken: string; user: any; tenant: any }>(
        "/auth/register",
        {
          method: "POST",
          body: JSON.stringify({ email, password, name, tenantName, ...(ref && { ref }) }),
        },
      );
      setAuth(res.token, res.tenant.id, res.refreshToken);
      router.replace("/onboarding");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.errors.generic"));
    } finally {
      setLoading(false);
    }
  }

  // Strength meter visual
  const strengthSegmentColors = [
    "bg-[var(--bv-status-failed)]",
    "bg-[var(--bv-status-running)]",
    "bg-primary",
    "bg-primary",
  ];
  const strengthKeys = ["weak", "fair", "good", "strong"] as const;

  return (
    <div className="bv-mesh min-h-screen flex">
      {/* ── Left brand panel ──────────────────────────────────── */}
      <div className="hidden lg:flex flex-col justify-between w-[45%] p-11 relative overflow-hidden border-r border-outline-variant">
        {/* Halo glow behind logo emblem */}
        <div
          className="animate-pulse-glow pointer-events-none"
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            zIndex: 1,
          }}
        >
          <div className="relative" style={{ width: "min(52%, 320px)", aspectRatio: "1" }}>
            <div
              className="absolute inset-[-16%] rounded-full"
              style={{
                background: "radial-gradient(circle, rgba(59,130,246,.35) 0%, rgba(59,130,246,.1) 40%, transparent 68%)",
                filter: "blur(12px)",
                animation: "float 5s ease-in-out infinite",
              }}
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/braavolabs-logo.png"
              alt=""
              aria-hidden="true"
              className="animate-float relative z-10 w-full h-full object-contain"
              style={{
                WebkitMask: "radial-gradient(circle, #000 70%, transparent 80%)",
                mask: "radial-gradient(circle, #000 70%, transparent 80%)",
                filter: "drop-shadow(0 12px 30px rgba(0,0,0,.7)) drop-shadow(0 0 26px rgba(59,130,246,.35))",
              }}
            />
          </div>
        </div>

        {/* Logo lockup */}
        <Link
          href="/"
          className="relative z-10 flex items-center gap-2.5 no-underline"
          style={{ textDecoration: "none" }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/braavolabs-logo.png"
            alt="Braavolabs"
            className="w-9 h-9 rounded-full"
          />
          <span
            className="font-headline font-bold text-base"
            style={{ color: "var(--color-on-surface)" }}
          >
            Braavolabs
          </span>
        </Link>

        {/* Value prop */}
        <div className="relative z-10 bv-stagger">
          <p
            className="font-headline font-extrabold mb-5"
            style={{
              fontSize: "clamp(22px,2.4vw,32px)",
              lineHeight: 1.1,
              letterSpacing: "-0.015em",
              textTransform: "uppercase",
              color: "var(--color-on-surface)",
            }}
          >
            Forge your<br />
            workspace in{" "}
            <span className="bv-grad-text">minutes</span>.
          </p>

          <ul className="flex flex-col gap-3 list-none p-0 m-0">
            {[
              { icon: "bolt", text: t("auth.register.inferenceFunding") },
              { icon: "key", text: "BYOK across 14 providers" },
              { icon: "smartphone", text: "Steer & approve from your pocket" },
            ].map((item) => (
              <li key={item.text} className="flex items-center gap-3">
                <div
                  className="w-7 h-7 rounded-lg flex-shrink-0 flex items-center justify-center"
                  style={{
                    background: "rgba(59,130,246,0.10)",
                    border: "1px solid rgba(59,130,246,0.25)",
                  }}
                >
                  <span
                    className="material-symbols-outlined"
                    style={{ fontSize: "15px", color: "#60A5FA" }}
                  >
                    {item.icon}
                  </span>
                </div>
                <span className="text-sm" style={{ color: "var(--color-on-surface-variant)" }}>
                  {item.text}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* Footer note */}
        <p className="relative z-10 text-xs" style={{ color: "var(--bv-text-faint)" }}>
          © {new Date().getFullYear()} Braavolabs. All rights reserved.
        </p>
      </div>

      {/* ── Right form panel ──────────────────────────────────── */}
      <div
        className="flex-1 flex items-center justify-center p-8 overflow-y-auto"
        style={{ minHeight: "100vh" }}
      >
        <div className="w-full max-w-[420px] bv-rise">
          {/* Mobile logo */}
          <Link
            href="/"
            className="lg:hidden flex items-center gap-2.5 mb-8 no-underline"
            style={{ textDecoration: "none" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/braavolabs-logo.png"
              alt="Braavolabs"
              className="w-8 h-8 rounded-lg"
            />
            <span
              className="font-headline font-bold"
              style={{ color: "var(--color-on-surface)" }}
            >
              Braavolabs
            </span>
          </Link>

          {/* Eyebrow pill */}
          <div className="flex items-center gap-2 mb-4">
            <span className="bv-pill bv-pill-cyan">
              <span
                className="bv-dot bv-running bv-ping"
                style={{ width: 6, height: 6 }}
              />
              Free plan
            </span>
          </div>

          <h1
            className="font-headline font-extrabold mb-1.5"
            style={{
              fontSize: "clamp(26px,2.8vw,34px)",
              letterSpacing: "-0.015em",
              textTransform: "uppercase",
              color: "var(--color-on-surface)",
              lineHeight: 1.1,
            }}
          >
            {t("auth.register.welcome")}
          </h1>
          <p className="text-sm mb-6" style={{ color: "var(--color-on-surface-variant)" }}>
            {t("auth.register.subtitle")}
          </p>

          {/* OAuth */}
          <div className="grid grid-cols-2 gap-3 mb-5">
            <button
              type="button"
              className="bv-btn bv-btn-ghost justify-center gap-2.5"
              onClick={async () => {
                try {
                  const { url } = await api.googleAuthUrl();
                  window.location.href = url;
                } catch (err) {
                  const msg = err instanceof Error ? err.message : "";
                  if (msg.includes("503") || msg.includes("not configured")) {
                    setError(t("auth.oauth.googleNotConfigured"));
                  } else if (msg.includes("fetch") || msg.includes("Failed") || msg.includes("ECONNREFUSED")) {
                    setError(t("auth.oauth.cannotConnect"));
                  } else {
                    setError(msg || t("auth.oauth.googleFailed"));
                  }
                }
              }}
            >
              <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>
              Google
            </button>
            <button
              type="button"
              className="bv-btn bv-btn-ghost justify-center gap-2.5"
              onClick={async () => {
                try {
                  const { url } = await api.githubAuthUrl();
                  window.location.href = url;
                } catch (err) {
                  const msg = err instanceof Error ? err.message : "";
                  if (msg.includes("503") || msg.includes("not configured")) {
                    setError(t("auth.oauth.githubNotConfigured"));
                  } else if (msg.includes("fetch") || msg.includes("Failed") || msg.includes("ECONNREFUSED")) {
                    setError(t("auth.oauth.cannotConnect"));
                  } else {
                    setError(msg || t("auth.oauth.githubFailed"));
                  }
                }
              }}
            >
              <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 .5A11.5 11.5 0 0 0 .5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.17c-3.2.7-3.87-1.36-3.87-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.75 1.18 1.75 1.18 1.02 1.74 2.67 1.24 3.32.95.1-.74.4-1.24.72-1.53-2.55-.29-5.24-1.27-5.24-5.66 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.15 1.17a10.94 10.94 0 0 1 5.74 0c2.19-1.48 3.15-1.17 3.15-1.17.62 1.58.23 2.75.11 3.04.74.8 1.18 1.82 1.18 3.07 0 4.4-2.69 5.36-5.26 5.65.41.36.78 1.06.78 2.13v3.16c0 .31.21.67.8.55A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5z" />
              </svg>
              GitHub
            </button>
          </div>

          {/* Divider */}
          <div className="flex items-center gap-3.5 mb-5">
            <div className="bv-divider flex-1" />
            <span
              className="bv-mono uppercase tracking-widest"
              style={{ fontSize: "11px", color: "var(--color-outline)", letterSpacing: "0.10em" }}
            >
              {t("auth.oauth.divider")}
            </span>
            <div className="bv-divider flex-1" />
          </div>

          {/* Error banner */}
          {error && (
            <div
              className="flex items-start gap-2.5 mb-4 px-4 py-3 rounded-xl text-sm"
              style={{
                background: "rgba(255,77,77,0.08)",
                border: "1px solid rgba(255,77,77,0.2)",
                color: "var(--color-error)",
              }}
            >
              <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: "16px", marginTop: "1px" }}>
                error
              </span>
              {error}
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
            {/* Name */}
            <ForgeField
              label={t("auth.fields.fullName")}
              type="text"
              value={name}
              onChange={setName}
              placeholder={t("auth.fields.fullNamePlaceholder")}
              required
              icon="person"
            />

            {/* Organisation */}
            <ForgeField
              label={t("auth.fields.organization")}
              type="text"
              value={tenantName}
              onChange={setTenantName}
              placeholder={t("auth.fields.organizationPlaceholder")}
              required
              icon="domain"
            />

            {/* Email */}
            <ForgeField
              label={t("auth.fields.email")}
              type="email"
              value={email}
              onChange={setEmail}
              placeholder={t("auth.fields.emailPlaceholder")}
              required
              icon="mail"
            />

            {/* Password + strength meter */}
            <div>
              <ForgeField
                label={t("auth.fields.password")}
                type="password"
                value={password}
                onChange={setPassword}
                placeholder={t("auth.fields.passwordRegisterPlaceholder")}
                required
                minLength={8}
                icon="lock"
              />
              {password && (
                <div className="mt-2">
                  {/* Meter bars */}
                  <div className="flex gap-1.5 mb-1.5">
                    {[0, 1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className="flex-1 h-[3px] rounded-full transition-all duration-300"
                        style={{
                          background:
                            i < pwStrength
                              ? i === 0
                                ? "var(--bv-status-failed)"
                                : i === 1
                                ? "var(--bv-status-running)"
                                : "var(--bv-cobalt-glow)"
                              : "rgba(255,255,255,0.06)",
                        }}
                      />
                    ))}
                  </div>
                  {pwStrength > 0 && (
                    <p className="bv-mono" style={{ fontSize: "11px", color: "var(--color-outline)" }}>
                      Strength —{" "}
                      <span style={{ color: "var(--color-on-surface-variant)" }}>
                        {t(`auth.strength.${strengthKeys[pwStrength - 1]}`)}
                      </span>
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Referral code (optional) */}
            <ForgeField
              label={t("auth.fields.referralCode")}
              type="text"
              value={ref}
              onChange={setRef}
              placeholder={t("auth.fields.referralCodePlaceholder")}
              optional
              optionalLabel={t("auth.fields.optional")}
              icon="card_giftcard"
            />

            {/* Terms checkbox */}
            <label
              className="flex items-start gap-2.5 cursor-pointer select-none"
              style={{ color: "var(--color-on-surface-variant)", fontSize: "13px", lineHeight: 1.5 }}
            >
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-0.5 flex-shrink-0"
                style={{
                  width: 15,
                  height: 15,
                  accentColor: "var(--bv-cobalt-glow)",
                  cursor: "pointer",
                }}
              />
              <span>
                I agree to the{" "}
                <Link href="/terms" className="text-primary hover:underline" style={{ textDecoration: "none" }}>
                  Terms
                </Link>{" "}
                and{" "}
                <Link href="/privacy" className="text-primary hover:underline" style={{ textDecoration: "none" }}>
                  Privacy Policy
                </Link>
                .
              </span>
            </label>

            {/* Submit CTA */}
            <button
              type="submit"
              disabled={loading || !agreed}
              className="bv-btn bv-btn-primary w-full justify-center mt-1 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ fontSize: "14px", padding: "13px 20px", borderRadius: "12px" }}
            >
              {loading ? (
                <>
                  <span className="material-symbols-outlined animate-spin-slow" style={{ fontSize: "16px" }}>
                    progress_activity
                  </span>
                  {t("auth.submit.loading")}
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>
                    rocket_launch
                  </span>
                  {t("auth.submit.createAccount")}
                </>
              )}
            </button>
          </form>

          {/* Footer */}
          <p
            className="text-center mt-6 text-sm"
            style={{ color: "var(--color-on-surface-variant)" }}
          >
            Already have an account?{" "}
            <Link
              href="/login"
              className="text-primary font-medium hover:underline"
              style={{ textDecoration: "none" }}
            >
              {t("auth.login.tabSignIn")}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

/** FORGE-styled form field with icon and focus ring. */
function ForgeField({
  label,
  type,
  value,
  onChange,
  placeholder,
  required,
  optional,
  optionalLabel,
  minLength,
  icon,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  required?: boolean;
  optional?: boolean;
  optionalLabel?: string;
  minLength?: number;
  icon?: string;
}) {
  return (
    <div>
      <label
        className="flex items-center gap-1 text-xs font-semibold mb-1.5"
        style={{ color: "var(--color-on-surface-variant)" }}
      >
        {icon && (
          <span className="material-symbols-outlined" style={{ fontSize: "13px" }}>
            {icon}
          </span>
        )}
        {label}
        {optional && (
          <span className="font-normal ml-1" style={{ color: "var(--color-outline)" }}>
            {optionalLabel ?? "(optional)"}
          </span>
        )}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        minLength={minLength}
        placeholder={placeholder}
        className="w-full px-4 py-2.5 rounded-xl text-sm outline-none transition-all"
        style={{
          background: "var(--bv-glass-bg)",
          border: "1px solid var(--bv-glass-border)",
          color: "var(--color-on-surface)",
        }}
        onFocus={(e) => {
          e.currentTarget.style.border = "1px solid rgba(59,130,246,0.5)";
          e.currentTarget.style.boxShadow = "0 0 0 3px rgba(59,130,246,0.08)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.border = "1px solid var(--bv-glass-border)";
          e.currentTarget.style.boxShadow = "none";
        }}
      />
    </div>
  );
}

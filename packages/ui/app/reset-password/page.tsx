"use client";
import { Suspense, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { api } from "../../lib/api";

// ── Password-strength helpers ─────────────────────────────────────
function calcStrength(v: string): number {
  if (!v) return 0;
  let s = 0;
  if (v.length >= 8) s++;
  if (/[A-Z]/.test(v) && /[a-z]/.test(v)) s++;
  if (/\d/.test(v)) s++;
  if (/[^A-Za-z0-9]/.test(v)) s++;
  return Math.min(s, 4);
}

const STRENGTH_COLORS = [
  "#FF8A8A", // molten — 1 bar
  "#F59E0B", // ember  — 2 bars
  "#60A5FA", // arc    — 3 bars
  "#7DD3FC", // plasma — 4 bars
] as const;

// ── Field component ───────────────────────────────────────────────
function Field({
  label,
  type,
  value,
  onChange,
  placeholder,
  autoComplete,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold mb-1.5 text-on-surface-variant uppercase tracking-wide">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="w-full px-4 py-2.5 rounded-xl text-sm outline-none transition-all"
        style={{
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.08)",
          color: "#E8EBF0",
        }}
        onFocus={(e) => {
          e.currentTarget.style.border = "1px solid rgba(96,165,250,0.5)";
          e.currentTarget.style.boxShadow = "0 0 0 3px rgba(96,165,250,0.08)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.border = "1px solid rgba(255,255,255,0.08)";
          e.currentTarget.style.boxShadow = "none";
        }}
      />
    </div>
  );
}

// ── Inner component (needs useSearchParams → must be in Suspense) ─
function ResetPasswordInner() {
  const t = useTranslations();
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  // UI state: "request" when no token, "new-password" when token present
  const [view, setView] = useState<"request" | "new-password" | "done">(
    token ? "new-password" : "request",
  );

  // Re-check token whenever searchParams change (client navigation)
  useEffect(() => {
    if (token) setView("new-password");
  }, [token]);

  // ── request-email state ────────────────────────────────────────
  const [reqEmail, setReqEmail] = useState("");
  const [reqStatus, setReqStatus] = useState<"idle" | "loading" | "sent" | "error">("idle");
  const [reqError, setReqError] = useState<string | null>(null);

  async function handleRequestSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reqEmail.trim()) return;
    setReqError(null);
    setReqStatus("loading");
    try {
      await api.forgotPassword(reqEmail.trim());
      setReqStatus("sent");
    } catch (err) {
      setReqError(err instanceof Error ? err.message : t("auth.errors.generic"));
      setReqStatus("error");
    }
  }

  // ── new-password state ─────────────────────────────────────────
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const strength = calcStrength(password);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) { setError(t("auth.validation.passwordMin")); return; }
    if (password !== confirm) { setError(t("auth.validation.passwordsMismatch")); return; }
    if (!token) { setError(t("auth.validation.invalidResetLink")); return; }
    setError(null);
    setStatus("loading");
    try {
      await api.resetPassword(token, password);
      setStatus("done");
      setView("done");
      // replace — consumed token; back-button shouldn't re-fire reset.
      setTimeout(() => router.replace("/login"), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.errors.generic"));
      setStatus("error");
    }
  }

  // ── Shared left panel ──────────────────────────────────────────
  const LeftPanel = (
    <div
      className="hidden lg:flex flex-col justify-between w-[42%] p-12 relative overflow-hidden"
      style={{
        background: "linear-gradient(160deg, #06070A 0%, #0B0D12 60%, #0B1120 100%)",
        borderRight: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      {/* Background glows */}
      <div
        className="absolute -top-32 -left-32 w-96 h-96 rounded-full opacity-10 blur-3xl pointer-events-none"
        style={{ background: "radial-gradient(circle, #3B82F6, transparent)" }}
      />
      <div
        className="absolute bottom-0 right-0 w-80 h-80 rounded-full opacity-8 blur-3xl pointer-events-none"
        style={{ background: "radial-gradient(circle, #2563EB, transparent)" }}
      />
      <div
        className="absolute inset-0 opacity-[0.025] pointer-events-none"
        style={{
          backgroundImage: "radial-gradient(circle, #ffffff 1px, transparent 1px)",
          backgroundSize: "28px 28px",
        }}
      />

      {/* Logo */}
      <div className="relative z-10 flex items-center gap-3">
        <div
          className="w-9 h-9 rounded-xl flex-shrink-0"
          style={{
            backgroundColor: "#06070A",
            backgroundImage: "url(/braavolabs-logo.png), linear-gradient(135deg, #3B82F6, #2563EB)",
            backgroundSize: "cover, cover",
            backgroundPosition: "center, center",
          }}
          aria-label="Braavolabs"
          role="img"
        />
        <span className="font-headline font-bold text-base text-on-surface">Braavolabs</span>
      </div>

      {/* Emblem */}
      <div className="relative z-10 flex-1 flex items-center justify-center">
        <div className="relative w-[min(58%,280px)] aspect-square">
          <div
            className="absolute inset-[-16%] rounded-full animate-pulse-glow pointer-events-none"
            style={{
              background:
                "radial-gradient(circle, rgba(59,130,246,0.35), rgba(59,130,246,0.08) 40%, transparent 68%)",
              filter: "blur(12px)",
            }}
          />
          <div
            className="relative w-full h-full animate-float"
            style={{
              backgroundImage: "url(/braavolabs-logo.png)",
              backgroundSize: "contain",
              backgroundPosition: "center",
              backgroundRepeat: "no-repeat",
              WebkitMask: "radial-gradient(circle, #000 70%, transparent 80%)",
              mask: "radial-gradient(circle, #000 70%, transparent 80%)",
              filter: "drop-shadow(0 0 26px rgba(59,130,246,0.35))",
            }}
            aria-label="Braavolabs emblem"
            role="img"
          />
        </div>
      </div>

      {/* Prop copy */}
      <div className="relative z-10">
        <p
          className="font-headline font-extrabold uppercase tracking-tight"
          style={{ fontSize: "clamp(18px,2vw,28px)", lineHeight: 1.15, maxWidth: "16ch", color: "#E8EBF0" }}
        >
          Forge a new{" "}
          <span className="gradient-text">key</span>
          {" "}to your war-room.
        </p>
        <p className="text-xs mt-2 text-on-surface-variant">{t("auth.brandPanel.footer")}</p>
      </div>
    </div>
  );

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div className="flex min-h-screen" style={{ background: "#06070A" }}>
      {LeftPanel}

      {/* Right form panel */}
      <div
        className="flex-1 flex items-center justify-center p-8 overflow-y-auto"
        style={{ background: "#0B0D12", minHeight: "100vh" }}
      >
        <div className="w-full max-w-[420px] animate-fade-in">
          {/* Mobile logo */}
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <div
              className="w-8 h-8 rounded-lg flex-shrink-0"
              style={{
                backgroundColor: "#06070A",
                backgroundImage: "url(/braavolabs-logo.png), linear-gradient(135deg, #3B82F6, #2563EB)",
                backgroundSize: "cover, cover",
                backgroundPosition: "center, center",
              }}
              aria-label="Braavolabs"
              role="img"
            />
            <span className="font-headline font-bold text-on-surface">Braavolabs</span>
          </div>

          {/* ── View: request email ──────────────────────────── */}
          {view === "request" && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-primary mb-2">
                Password Reset
              </p>
              <h1 className="font-headline font-bold text-2xl text-on-surface mb-2">
                {t("auth.reset.title")}
              </h1>
              <p className="text-sm text-on-surface-variant mb-7">
                Enter your email and we&apos;ll send a reset link.
              </p>

              {reqStatus === "sent" ? (
                <div className="text-center py-8">
                  <div
                    className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4"
                    style={{
                      background: "rgba(96,165,250,0.12)",
                      border: "1px solid rgba(96,165,250,0.3)",
                    }}
                  >
                    <span className="material-symbols-outlined text-3xl text-primary">mark_email_read</span>
                  </div>
                  <h2 className="font-headline font-bold text-lg text-on-surface mb-2">
                    {t("auth.forgot.successTitle")}
                  </h2>
                  <p className="text-sm text-on-surface-variant mb-6">{t("auth.forgot.successDesc")}</p>
                  <a
                    href="/login"
                    className="text-sm font-semibold text-primary hover:opacity-80 transition-opacity"
                  >
                    ← {t("auth.reset.back")}
                  </a>
                </div>
              ) : (
                <form onSubmit={handleRequestSubmit} className="space-y-4" noValidate>
                  {reqError && (
                    <div
                      className="px-4 py-3 rounded-xl text-sm"
                      style={{
                        background: "rgba(255,138,138,0.08)",
                        border: "1px solid rgba(255,138,138,0.2)",
                        color: "#FF8A8A",
                      }}
                    >
                      {reqError}
                    </div>
                  )}

                  <Field
                    label={t("auth.fields.email")}
                    type="email"
                    value={reqEmail}
                    onChange={setReqEmail}
                    placeholder={t("auth.fields.emailPlaceholder")}
                    autoComplete="email"
                  />

                  <button
                    type="submit"
                    disabled={reqStatus === "loading"}
                    className="btn-primary w-full justify-center py-3 rounded-xl text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {reqStatus === "loading" ? (
                      <>
                        <span className="material-symbols-outlined text-base animate-spin">progress_activity</span>
                        Sending…
                      </>
                    ) : (
                      <>
                        <span className="material-symbols-outlined text-base">send</span>
                        Send reset link
                      </>
                    )}
                  </button>

                  <div className="text-center pt-1">
                    <a href="/login" className="text-xs text-on-surface-variant hover:text-primary transition-colors">
                      ← {t("auth.reset.back")}
                    </a>
                  </div>
                </form>
              )}
            </div>
          )}

          {/* ── View: set new password ───────────────────────── */}
          {view === "new-password" && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-primary mb-2">
                Password Reset
              </p>
              <h1 className="font-headline font-bold text-2xl text-on-surface mb-2">
                Set a new password
              </h1>
              <p className="text-sm text-on-surface-variant mb-7">
                {t("auth.reset.subtitle")}
              </p>

              {error && (
                <div
                  className="px-4 py-3 rounded-xl text-sm mb-4"
                  style={{
                    background: "rgba(255,138,138,0.08)",
                    border: "1px solid rgba(255,138,138,0.2)",
                    color: "#FF8A8A",
                  }}
                >
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4" noValidate>
                <div>
                  <Field
                    label={t("auth.fields.password")}
                    type="password"
                    value={password}
                    onChange={setPassword}
                    placeholder={t("auth.reset.newPasswordPlaceholder")}
                    autoComplete="new-password"
                  />
                  {/* Strength meter */}
                  {password && (
                    <div className="mt-2">
                      <div className="flex gap-1.5 mb-1">
                        {[0, 1, 2, 3].map((i) => (
                          <div
                            key={i}
                            className="flex-1 h-1 rounded-full transition-all duration-300"
                            style={{
                              background:
                                i < strength
                                  ? STRENGTH_COLORS[Math.max(0, strength - 1)]
                                  : "rgba(255,255,255,0.06)",
                            }}
                          />
                        ))}
                      </div>
                      {strength > 0 && (
                        <p className="text-xs text-on-surface-variant">
                          {["Weak", "Fair", "Good", "Strong"][strength - 1]}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <Field
                  label="Confirm password"
                  type="password"
                  value={confirm}
                  onChange={setConfirm}
                  placeholder={t("auth.reset.confirmPasswordPlaceholder")}
                  autoComplete="new-password"
                />

                <button
                  type="submit"
                  disabled={status === "loading"}
                  className="btn-primary w-full justify-center py-3 rounded-xl text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {status === "loading" ? (
                    <>
                      <span className="material-symbols-outlined text-base animate-spin">progress_activity</span>
                      {t("auth.reset.loading")}
                    </>
                  ) : (
                    <>
                      <span className="material-symbols-outlined text-base">lock_reset</span>
                      {t("auth.reset.submit")}
                    </>
                  )}
                </button>
              </form>
            </div>
          )}

          {/* ── View: success ────────────────────────────────── */}
          {view === "done" && (
            <div className="text-center py-8">
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-5"
                style={{
                  background: "rgba(96,165,250,0.12)",
                  border: "1px solid rgba(96,165,250,0.3)",
                }}
              >
                <span className="material-symbols-outlined text-4xl text-primary">verified</span>
              </div>
              <p className="text-xs font-semibold uppercase tracking-widest text-primary mb-2">
                Password forged
              </p>
              <h2 className="font-headline font-bold text-xl text-on-surface mb-2">
                {t("auth.reset.successTitle")}
              </h2>
              <p className="text-sm text-on-surface-variant mb-8">
                {t("auth.reset.successDesc")}
              </p>
              <a
                href="/login"
                className="btn-primary inline-flex justify-center py-3 px-6 rounded-xl text-sm font-semibold"
              >
                <span className="material-symbols-outlined text-base">login</span>
                Sign in
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div
          className="flex min-h-screen items-center justify-center"
          style={{ background: "#06070A" }}
        />
      }
    >
      <ResetPasswordInner />
    </Suspense>
  );
}

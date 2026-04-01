"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, api } from "../../lib/api";
import { useAppStore } from "../../lib/store";

export default function LoginPage() {
  const router = useRouter();
  const token = useAppStore((s) => s.token);
  const hydrated = useAppStore((s) => s._hydrated);
  const setAuth = useAppStore((s) => s.setAuth);
  const [mode, setMode] = useState<"login" | "register">("login");
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
    if (hydrated && token) router.push("/dashboard");
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
    if (!email.trim()) return "Email is required.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Please enter a valid email address.";
    if (!password) return "Password is required.";
    if (password.length < 8) return "Password must be at least 8 characters.";
    if (mode === "register") {
      if (!name.trim()) return "Full name is required.";
      if (!tenantName.trim()) return "Organization name is required.";
    }
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
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
        setAuth(res.token, res.tenant.id, res.refreshToken);
        router.push("/dashboard");
      } else {
        const res = await apiFetch<{ token: string; refreshToken: string; user: any; tenant: any }>(
          "/auth/register",
          {
            method: "POST",
            body: JSON.stringify({ email, password, name, tenantName, ...(ref && { ref }) }),
          },
        );
        setAuth(res.token, res.tenant.id, res.refreshToken);
        router.push("/onboarding");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  const strengthColors = ["bg-red-500", "bg-orange-500", "bg-yellow-500", "bg-emerald-500"];
  const strengthLabels = ["Weak", "Fair", "Good", "Strong"];

  return (
    <div className="flex min-h-screen" style={{ background: "#0a0d14" }}>
      {/* ── Left brand panel ─────────────────────────────── */}
      <div
        className="hidden lg:flex flex-col justify-between w-[42%] p-12 relative overflow-hidden neural-mesh"
        style={{ background: "linear-gradient(160deg, #0a0d14 0%, #1a0e2e 60%, #0b1a2e 100%)" }}
      >
        {/* Ambient orbs */}
        <div className="absolute -top-32 -left-32 w-96 h-96 rounded-full opacity-[0.12] blur-3xl" style={{ background: "radial-gradient(circle, #00d1ff, transparent)" }} />
        <div className="absolute bottom-0 right-0 w-80 h-80 rounded-full opacity-[0.10] blur-3xl" style={{ background: "radial-gradient(circle, #6d11ad, transparent)" }} />
        <div className="absolute inset-0 opacity-[0.025]" style={{ backgroundImage: "radial-gradient(circle, #ffffff 1px, transparent 1px)", backgroundSize: "28px 28px" }} />

        {/* Logo */}
        <div className="relative z-10 flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
          >
            <span className="font-bold text-sm text-white">AI</span>
          </div>
          <span
            className="font-headline font-bold text-base"
            style={{ color: "#e1e2eb" }}
          >
            AI Company OS
          </span>
        </div>

        {/* Middle content */}
        <div className="relative z-10">
          <h2
            className="font-headline font-extrabold mb-4"
            style={{ fontSize: "2rem", lineHeight: 1.2, color: "#e1e2eb" }}
          >
            Your autonomous<br />
            <span
              style={{
                background: "linear-gradient(135deg, #00d1ff, #a4e6ff)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              business,
            </span>
            <br />always on.
          </h2>
          <p className="text-sm mb-8" style={{ color: "#bbc9cf", lineHeight: 1.7, maxWidth: "320px" }}>
            Build AI-powered companies that run sales, content, and operations 24/7 — with full audit logs and human approval gates.
          </p>

          <div className="space-y-4">
            {[
              { icon: "bolt", text: "AI agents run 24/7 — sales, content, ops" },
              { icon: "history", text: "Full audit log of every decision" },
              { icon: "rocket_launch", text: "10 minutes to your first company" },
            ].map((item) => (
              <div key={item.text} className="flex items-center gap-3">
                <div
                  className="w-8 h-8 rounded-lg flex-shrink-0 flex items-center justify-center"
                  style={{ background: "rgba(0,209,255,0.1)", border: "1px solid rgba(0,209,255,0.25)" }}
                >
                  <span className="material-symbols-outlined text-base" style={{ color: "#00d1ff" }}>
                    {item.icon}
                  </span>
                </div>
                <span className="text-sm" style={{ color: "#bbc9cf" }}>{item.text}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom */}
        <div className="relative z-10">
          <p className="text-xs" style={{ color: "#3c494e" }}>© 2026 AI Company OS. Built with Claude.</p>
        </div>
      </div>

      {/* ── Right form panel ─────────────────────────────── */}
      <div
        className="flex-1 flex items-start justify-center p-8 overflow-y-auto"
        style={{ background: "#191c22", minHeight: "100vh" }}
      >
        <div className="w-full max-w-[420px] py-8">
          {/* Mobile logo */}
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
            >
              <span className="font-bold text-xs text-white">AI</span>
            </div>
            <span className="font-headline font-bold" style={{ color: "#e1e2eb" }}>
              AI Company OS
            </span>
          </div>

          <h2 className="font-headline font-bold text-2xl mb-2" style={{ color: "#e1e2eb" }}>
            {mode === "login" ? "Welcome back" : "Create account"}
          </h2>
          <p className="text-sm mb-7" style={{ color: "#bbc9cf" }}>
            {mode === "login" ? "Sign in to your AI Company OS account" : "Start building autonomous AI companies"}
          </p>

          {/* Tab toggle */}
          <div
            className="flex p-1 rounded-xl mb-6"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}
          >
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setError(null); }}
                className="flex-1 py-2 rounded-lg text-sm font-semibold transition-all"
                style={{
                  background: mode === m ? "rgba(255,255,255,0.08)" : "transparent",
                  color: mode === m ? "#e1e2eb" : "#859399",
                }}
              >
                {m === "login" ? "Sign In" : "Register"}
              </button>
            ))}
          </div>

          {error && (
            <div
              className="mb-4 px-4 py-3 rounded-xl text-sm"
              style={{ background: "rgba(255,180,171,0.08)", border: "1px solid rgba(255,180,171,0.2)", color: "#ffb4ab" }}
            >
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            {mode === "register" && (
              <>
                <Field label="Full Name" type="text" value={name} onChange={setName} placeholder="Jane Smith" required />
                <Field label="Organization" type="text" value={tenantName} onChange={setTenantName} placeholder="Your company or team" required />
              </>
            )}

            <Field label="Email" type="email" value={email} onChange={setEmail} placeholder="you@example.com" required />
            <div>
              <Field label="Password" type="password" value={password} onChange={setPassword} placeholder="Min. 8 characters" required minLength={8} />
              {mode === "login" && (
                <div className="flex justify-end mt-1.5">
                  <button type="button" onClick={() => setShowForgot(true)} className="text-xs transition-colors hover:opacity-80" style={{ color: "#a4e6ff", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                    Forgot password?
                  </button>
                </div>
              )}
              {mode === "register" && password && (
                <div className="mt-2">
                  <div className="flex gap-1 mb-1">
                    {[0, 1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className="flex-1 h-1 rounded-full transition-all duration-300"
                        style={{ background: i < pwStrength ? (strengthColors[pwStrength - 1] || "#00d1ff") : "rgba(255,255,255,0.06)" }}
                      />
                    ))}
                  </div>
                  {pwStrength > 0 && (
                    <p className="text-xs" style={{ color: "#859399" }}>
                      Password strength: <span style={{ color: "#bbc9cf" }}>{strengthLabels[pwStrength - 1]}</span>
                    </p>
                  )}
                </div>
              )}
            </div>

            {mode === "register" && (
              <Field label="Referral Code" type="text" value={ref} onChange={setRef} placeholder="Optional" optional />
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: "linear-gradient(135deg, #00d1ff, #6d11ad)",
                marginTop: "0.5rem",
                boxShadow: "0 0 24px rgba(0,209,255,0.2)",
              }}
            >
              {loading ? "Loading..." : mode === "login" ? "Sign In" : "Create Account"}
            </button>
          </form>

          {/* Divider */}
          <div className="flex items-center my-5">
            <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.06)" }} />
            <span className="px-4 text-[11px] uppercase tracking-wide" style={{ color: "#3c494e" }}>
              or continue with
            </span>
            <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.06)" }} />
          </div>

          {/* Google OAuth */}
          <button
            onClick={async () => {
              try {
                const { url } = await api.googleAuthUrl();
                window.location.href = url;
              } catch (err) {
                const msg = err instanceof Error ? err.message : "";
                if (msg.includes("503") || msg.includes("not configured")) {
                  setError("Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env file, or use email/password login.");
                } else if (msg.includes("fetch") || msg.includes("Failed") || msg.includes("ECONNREFUSED")) {
                  setError("Cannot connect to API server. Make sure the backend is running on port 8080.");
                } else {
                  setError(msg || "Google login failed. Please try email/password.");
                }
              }
            }}
            className="w-full flex items-center justify-center gap-3 py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-80"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Continue with Google
          </button>
        </div>
      </div>

      {/* ── Forgot Password Modal ─────────────────────────── */}
      {showForgot && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}>
          <div className="w-full max-w-[400px] rounded-2xl p-6" style={{ background: "#191c22", border: "1px solid rgba(255,255,255,0.08)" }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-base" style={{ color: "#e1e2eb" }}>Reset Password</h3>
              <button
                onClick={() => { setShowForgot(false); setForgotStatus("idle"); setForgotError(null); setForgotEmail(""); }}
                style={{ color: "#859399", background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center" }}
              >
                <span className="material-symbols-outlined text-xl">close</span>
              </button>
            </div>

            {forgotStatus === "sent" ? (
              <div className="text-center py-4">
                <span className="material-symbols-outlined text-4xl mb-3 block" style={{ color: "#34d399" }}>mark_email_read</span>
                <p className="font-semibold mb-1" style={{ color: "#e1e2eb" }}>Check your email</p>
                <p className="text-sm" style={{ color: "#859399" }}>If that address is registered, we sent a reset link. Check your spam folder too.</p>
                <button
                  onClick={() => { setShowForgot(false); setForgotStatus("idle"); setForgotEmail(""); }}
                  className="mt-4 text-sm"
                  style={{ color: "#a4e6ff", background: "none", border: "none", cursor: "pointer", padding: 0 }}
                >
                  Back to login
                </button>
              </div>
            ) : (
              <>
                <p className="text-sm mb-4" style={{ color: "#859399" }}>Enter your email and we&apos;ll send you a reset link.</p>
                {forgotError && (
                  <div className="px-3 py-2 rounded-xl mb-3 text-sm" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "#f87171" }}>
                    {forgotError}
                  </div>
                )}
                <input
                  type="email"
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                  placeholder="you@example.com"
                  className="w-full px-4 py-2.5 rounded-xl text-sm outline-none mb-3"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }}
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
                      setForgotError(err instanceof Error ? err.message : "Something went wrong");
                    }
                  }}
                  disabled={forgotStatus === "loading" || !forgotEmail.trim()}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50"
                  style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", border: "none", cursor: "pointer" }}
                >
                  {forgotStatus === "loading" ? "Sending..." : "Send Reset Link"}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label, type, value, onChange, placeholder, required, optional, minLength,
}: {
  label: string; type: string; value: string; onChange: (v: string) => void;
  placeholder: string; required?: boolean; optional?: boolean; minLength?: number;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold mb-1.5" style={{ color: "#bbc9cf" }}>
        {label}
        {optional && <span className="font-normal ml-1" style={{ color: "#3c494e" }}>(optional)</span>}
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
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.08)",
          color: "#e1e2eb",
        }}
        onFocus={(e) => {
          e.currentTarget.style.border = "1px solid rgba(0,209,255,0.5)";
          e.currentTarget.style.boxShadow = "0 0 0 3px rgba(0,209,255,0.08)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.border = "1px solid rgba(255,255,255,0.08)";
          e.currentTarget.style.boxShadow = "none";
        }}
      />
    </div>
  );
}

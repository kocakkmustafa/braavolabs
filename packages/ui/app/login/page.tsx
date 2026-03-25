"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, api } from "../../lib/api";
import { useAppStore } from "../../lib/store";

export default function LoginPage() {
  const router = useRouter();
  const token = useAppStore((s) => s.token);
  const setAuth = useAppStore((s) => s.setAuth);
  const [mode, setMode] = useState<"login" | "register">("login");

  // Redirect to dashboard if already authenticated
  useEffect(() => {
    if (token) {
      router.push("/");
    }
  }, [token, router]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (mode === "login") {
        const res = await apiFetch<{ token: string; user: any; tenant: any }>(
          "/auth/login",
          { method: "POST", body: JSON.stringify({ email, password }) },
        );
        setAuth(res.token, res.tenant.id);
        router.push("/");
      } else {
        const res = await apiFetch<{ token: string; user: any; tenant: any }>(
          "/auth/register",
          {
            method: "POST",
            body: JSON.stringify({
              email,
              password,
              name,
              tenantName,
              ...(ref && { ref }),
            }),
          },
        );
        setAuth(res.token, res.tenant.id);
        router.push("/onboarding");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-[#0d0f14]">
      {/* Background gradient orbs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -left-40 w-96 h-96 rounded-full bg-brand-600/10 blur-3xl" />
        <div className="absolute -bottom-40 -right-40 w-96 h-96 rounded-full bg-violet-600/10 blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-brand-900/10 blur-3xl" />
      </div>
      {/* Grid pattern */}
      <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxwYXRoIGQ9Ik0wIDBoNDB2NDBIMHoiLz48cGF0aCBkPSJNNDAgMEgwdjQwaDQwVjB6TTEgMWgzOHYzOEgxVjF6IiBmaWxsPSJyZ2JhKDI1NSwyNTUsMjU1LDAuMDIpIi8+PC9nPjwvc3ZnPg==')] opacity-80" />

      <div className="relative card-glass rounded-3xl p-10 max-w-[420px] w-full mx-4 animate-slide-up">
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl gradient-brand flex items-center justify-center mx-auto mb-4 shadow-lg shadow-brand-500/30">
            <span className="text-white font-bold text-lg">AI</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-100">AI Company OS</h1>
          <p className="text-slate-500 text-sm mt-1.5">Build autonomous AI companies in minutes</p>
        </div>

        {/* Tab Toggle */}
        <div className="flex bg-white/[0.06] rounded-xl p-1 mb-6 border border-white/[0.08]">
          <button
            onClick={() => setMode("login")}
            className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${
              mode === "login"
                ? "bg-white/10 text-slate-100 shadow-sm"
                : "text-slate-500 hover:text-slate-400"
            }`}
          >
            Sign In
          </button>
          <button
            onClick={() => setMode("register")}
            className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${
              mode === "register"
                ? "bg-white/10 text-slate-100 shadow-sm"
                : "text-slate-500 hover:text-slate-400"
            }`}
          >
            Register
          </button>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl mb-4 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === "register" && (
            <>
              <Input label="Name" type="text" value={name} onChange={setName} placeholder="Your name" required />
              <Input label="Organization" type="text" value={tenantName} onChange={setTenantName} placeholder="Your company or team" required />
            </>
          )}

          <Input label="Email" type="email" value={email} onChange={setEmail} placeholder="you@example.com" required />
          <Input label="Password" type="password" value={password} onChange={setPassword} placeholder="Min. 6 characters" required minLength={6} />

          {mode === "register" && (
            <Input label="Referral Code" type="text" value={ref} onChange={setRef} placeholder="Optional" optional />
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-xl text-sm font-semibold text-white gradient-brand shadow-lg shadow-brand-500/25 hover:shadow-brand-500/40 transition-all disabled:opacity-50 disabled:cursor-not-allowed mt-2"
          >
            {loading ? "Loading..." : mode === "login" ? "Sign In" : "Create Account"}
          </button>
        </form>

        {/* Divider */}
        <div className="flex items-center my-6">
          <div className="flex-1 border-t border-white/[0.08]" />
          <span className="px-4 text-[11px] text-slate-600 uppercase tracking-wide">or</span>
          <div className="flex-1 border-t border-white/[0.08]" />
        </div>

        {/* Google OAuth */}
        <button
          onClick={async () => {
            try {
              const { url } = await api.googleAuthUrl();
              window.location.href = url;
            } catch {
              setError("Google login is not configured");
            }
          }}
          className="w-full flex items-center justify-center gap-3 border border-white/[0.08] rounded-xl py-3 font-semibold text-sm text-slate-300 hover:bg-white/[0.06] hover:text-slate-100 transition-colors"
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
  );
}

function Input({
  label,
  type,
  value,
  onChange,
  placeholder,
  required,
  optional,
  minLength,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  required?: boolean;
  optional?: boolean;
  minLength?: number;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-400 mb-1.5">
        {label}
        {optional && <span className="text-slate-600 font-normal ml-1">(optional)</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        minLength={minLength}
        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-slate-200 placeholder-slate-600 focus:ring-2 focus:ring-brand-500/50 focus:border-brand-500/50 outline-none transition-all"
        placeholder={placeholder}
      />
    </div>
  );
}

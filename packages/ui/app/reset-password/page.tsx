"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { api } from "../../lib/api";

function ResetPasswordInner() {
  const t = useTranslations();
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

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
      // replace — once the password is reset, the consumed reset
      // token in the URL is invalid; back-button shouldn't return to
      // a stale page that re-fires the reset.
      setTimeout(() => router.replace("/login"), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.errors.generic"));
      setStatus("error");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4" style={{ background: "#0a0d14" }}>
      <div className="w-full max-w-[400px]">
        <div className="flex items-center gap-2 mb-8 justify-center">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}>
            <span className="text-white font-bold text-xs">AI</span>
          </div>
          <span className="font-bold text-sm" style={{ color: "#e1e2eb" }}>Braavolabs</span>
        </div>

        <div className="rounded-2xl p-6" style={{ background: "rgba(29,32,38,0.8)", border: "1px solid rgba(255,255,255,0.08)" }}>
          {status === "done" ? (
            <div className="text-center py-4">
              <span className="material-symbols-outlined text-4xl mb-3 block" style={{ color: "#34d399" }}>check_circle</span>
              <p className="font-semibold mb-1" style={{ color: "#e1e2eb" }}>{t("auth.reset.successTitle")}</p>
              <p className="text-sm" style={{ color: "#859399" }}>{t("auth.reset.successDesc")}</p>
            </div>
          ) : (
            <>
              <h1 className="font-bold text-lg mb-1" style={{ color: "#e1e2eb" }}>{t("auth.reset.title")}</h1>
              <p className="text-sm mb-5" style={{ color: "#859399" }}>{t("auth.reset.subtitle")}</p>

              {error && (
                <div className="px-3 py-2 rounded-xl mb-4 text-sm" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "#f87171" }}>
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-3" noValidate>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t("auth.reset.newPasswordPlaceholder")}
                  className="w-full px-4 py-2.5 rounded-xl text-sm outline-none"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }}
                />
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder={t("auth.reset.confirmPasswordPlaceholder")}
                  className="w-full px-4 py-2.5 rounded-xl text-sm outline-none"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }}
                />
                <button
                  type="submit"
                  disabled={status === "loading"}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50"
                  style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
                >
                  {status === "loading" ? t("auth.reset.loading") : t("auth.reset.submit")}
                </button>
              </form>

              <div className="text-center mt-4">
                <a href="/login" className="text-xs" style={{ color: "#859399" }}>{t("auth.reset.back")}</a>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center" style={{ background: "#0a0d14" }} />}>
      <ResetPasswordInner />
    </Suspense>
  );
}

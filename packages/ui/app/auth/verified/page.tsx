"use client";

/**
 * Email verification result page.
 *
 * Lands here after the API's GET /api/v1/auth/verify-email handler
 * redirects with a status query param:
 *   - ok      → success, show "you're verified, <email>" + link to dashboard
 *   - invalid → token doesn't match or expired
 *   - error   → unexpected (network, db, etc)
 *
 * Renders entirely client-side; no server data fetch needed. The API
 * has already done the heavy lifting before this page loads.
 */

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

function VerifiedInner() {
  const t = useTranslations();
  const params = useSearchParams();
  const status = params.get("status") ?? "ok";
  const email = params.get("email");

  if (status === "ok") {
    return (
      <Scene
        variant="ok"
        title={t("app.authVerified.okTitle")}
        body={<p className="text-on-surface-variant text-[17px] max-w-[40ch] mx-auto mt-4 mb-8">{t("app.authVerified.okBody", { suffix: email ? `, ${email}` : "" })}</p>}
        cta={{ href: "/dashboard", label: t("app.authVerified.okCta") }}
      />
    );
  }

  if (status === "invalid") {
    return (
      <Scene
        variant="error"
        title={t("app.authVerified.invalidTitle")}
        body={
          <p className="text-on-surface-variant text-[17px] max-w-[40ch] mx-auto mt-4 mb-8">
            {t.rich("app.authVerified.invalidBody", { s: (c) => <span className="opacity-70">{c}</span> })}
          </p>
        }
        cta={{ href: "/login", label: t("app.authVerified.invalidCta") }}
      />
    );
  }

  return (
    <Scene
      variant="error"
      title={t("app.authVerified.errorTitle")}
      body={
        <p className="text-on-surface-variant text-[17px] max-w-[40ch] mx-auto mt-4 mb-8">
          {t.rich("app.authVerified.errorBody", {
            a: (c) => (
              <a href="mailto:founder@braavolabs.com" className="text-primary underline underline-offset-2">
                {c}
              </a>
            ),
          })}
        </p>
      }
      cta={{ href: "/login", label: t("app.authVerified.errorCta") }}
    />
  );
}

export default function VerifiedPage() {
  const t = useTranslations();
  return (
    <Suspense
      fallback={
        <Scene
          variant="loading"
          title={t("app.authVerified.verifying")}
          body={<p className="text-on-surface-variant text-[17px] max-w-[40ch] mx-auto mt-4 mb-8">{t("app.authVerified.verifyingBody")}</p>}
        />
      }
    >
      <VerifiedInner />
    </Suspense>
  );
}

/* ── Scene ──────────────────────────────────────────────────────── */

type SceneVariant = "ok" | "error" | "loading";

function Scene({
  variant,
  title,
  body,
  cta,
}: {
  variant: SceneVariant;
  title: string;
  body: React.ReactNode;
  cta?: { href: string; label: string };
}) {
  return (
    <div className="mesh-bg min-h-screen bg-background flex flex-col items-center justify-center text-center px-6 overflow-hidden">
      {/* ambient arc glow */}
      <div
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          background:
            "radial-gradient(ellipse 60% 50% at 50% 45%, rgba(59,130,246,0.10) 0%, transparent 65%)",
        }}
      />

      <div className="relative z-10 flex flex-col items-center animate-scale-in">
        {/* emblem with pulsing halo */}
        <div className="relative w-[150px] aspect-square mb-4 flex items-center justify-center">
          {/* halo */}
          <span
            className="absolute inset-[-18%] rounded-full animate-pulse-glow pointer-events-none"
            style={{
              background:
                "radial-gradient(circle, rgba(59,130,246,0.45), transparent 65%)",
              filter: "blur(12px)",
            }}
          />
          {/* logo mark */}
          <span
            className="relative z-10 flex items-center justify-center w-full h-full"
            style={{
              filter: "drop-shadow(0 0 30px rgba(59,130,246,0.5))",
              animation: "vpulse 2.2s ease-in-out infinite",
            }}
          >
            {/* logo letters as display text — keeps it self-contained without an img asset */}
            <span
              className="font-headline font-bold text-4xl tracking-tight gradient-text select-none"
              style={{ letterSpacing: "-0.04em" }}
            >
              BL
            </span>
          </span>

          {/* check badge */}
          {variant === "ok" && (
            <span
              className="absolute bottom-[-2px] right-2 z-20 w-[42px] h-[42px] rounded-full bg-primary flex items-center justify-center border-2 border-background text-white text-xl"
              style={{ boxShadow: "0 0 20px rgba(59,130,246,0.6)" }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 20 }}>
                check
              </span>
            </span>
          )}

          {variant === "error" && (
            <span
              className="absolute bottom-[-2px] right-2 z-20 w-[42px] h-[42px] rounded-full bg-error-container flex items-center justify-center border-2 border-background text-error text-xl"
              style={{ boxShadow: "0 0 20px rgba(255,138,138,0.4)" }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 20 }}>
                error
              </span>
            </span>
          )}

          {variant === "loading" && (
            <span
              className="absolute bottom-[-2px] right-2 z-20 w-[42px] h-[42px] rounded-full bg-surface-container-high flex items-center justify-center border-2 border-background text-on-surface-variant"
            >
              <span className="material-symbols-outlined animate-spin" style={{ fontSize: 20, animationDuration: "1s" }}>
                progress_activity
              </span>
            </span>
          )}
        </div>

        {/* eyebrow */}
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant mb-2">
          Braavolabs
        </p>

        {/* heading */}
        <h1
          className="font-headline text-on-surface font-semibold uppercase tracking-tight"
          style={{ fontSize: "clamp(30px, 4.4vw, 52px)", lineHeight: 1 }}
        >
          {title}
        </h1>

        {/* body */}
        {body}

        {/* CTA */}
        {cta && (
          <Link href={cta.href} className="btn-primary glow-cyan text-sm font-semibold no-underline">
            {cta.label}
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
              arrow_forward
            </span>
          </Link>
        )}
      </div>

      <style>{`
        @keyframes vpulse {
          0%, 100% { filter: drop-shadow(0 0 20px rgba(59,130,246,0.4)); }
          50%       { filter: drop-shadow(0 0 40px rgba(96,165,250,0.7)); }
        }
      `}</style>
    </div>
  );
}

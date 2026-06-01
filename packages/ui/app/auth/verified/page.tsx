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
      <Card
        title={t("app.authVerified.okTitle")}
        body={<p>{t("app.authVerified.okBody", { suffix: email ? `, ${email}` : "" })}</p>}
        cta={{ href: "/dashboard", label: t("app.authVerified.okCta") }}
      />
    );
  }

  if (status === "invalid") {
    return (
      <Card
        title={t("app.authVerified.invalidTitle")}
        body={<p>{t.rich("app.authVerified.invalidBody", { s: (c) => <span style={{ opacity: 0.7 }}>{c}</span> })}</p>}
        cta={{ href: "/login", label: t("app.authVerified.invalidCta") }}
      />
    );
  }

  return (
    <Card
      title={t("app.authVerified.errorTitle")}
      body={<p>{t.rich("app.authVerified.errorBody", { a: (c) => <a href="mailto:founder@braavolabs.com" style={{ color: "#00d1ff" }}>{c}</a> })}</p>}
      cta={{ href: "/login", label: t("app.authVerified.errorCta") }}
    />
  );
}

export default function VerifiedPage() {
  const t = useTranslations();
  return (
    <Suspense fallback={<Card title={t("app.authVerified.verifying")} body={<p>{t("app.authVerified.verifyingBody")}</p>} />}>
      <VerifiedInner />
    </Suspense>
  );
}

function Card({
  title,
  body,
  cta,
}: {
  title: string;
  body: React.ReactNode;
  cta?: { href: string; label: string };
}) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0d14",
        color: "#e1e2eb",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          maxWidth: 460,
          width: "100%",
          background: "rgba(15,18,25,0.6)",
          borderRadius: 16,
          border: "1px solid rgba(255,255,255,0.05)",
          padding: 32,
          backdropFilter: "blur(20px)",
        }}
      >
        <h1
          style={{
            fontSize: 22,
            fontWeight: 700,
            marginTop: 0,
            marginBottom: 16,
            letterSpacing: -0.5,
          }}
        >
          {title}
        </h1>
        <div
          style={{
            color: "#bbc9cf",
            fontSize: 14,
            lineHeight: 1.6,
            marginBottom: 24,
          }}
        >
          {body}
        </div>
        {cta && (
          <Link
            href={cta.href}
            style={{
              display: "inline-flex",
              padding: "10px 18px",
              borderRadius: 12,
              background: "linear-gradient(135deg,#00d1ff,#6d11ad)",
              color: "#fff",
              fontWeight: 600,
              fontSize: 14,
              textDecoration: "none",
            }}
          >
            {cta.label}
          </Link>
        )}
      </div>
    </div>
  );
}

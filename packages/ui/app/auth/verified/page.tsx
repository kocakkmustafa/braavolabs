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

function VerifiedInner() {
  const params = useSearchParams();
  const status = params.get("status") ?? "ok";
  const email = params.get("email");

  if (status === "ok") {
    return (
      <Card
        title="Email verified ✓"
        body={
          <>
            <p>
              Thanks{email ? `, ${email}` : ""}. Your inbox is now linked to your
              Braavolabs account — we&apos;ll use it for approvals, risk alerts
              and account recovery.
            </p>
          </>
        }
        cta={{ href: "/dashboard", label: "Go to dashboard →" }}
      />
    );
  }

  if (status === "invalid") {
    return (
      <Card
        title="Link no longer valid"
        body={
          <p>
            Verification links expire after 7 days. Sign in and we&apos;ll send
            you a fresh one from <span style={{ opacity: 0.7 }}>Settings → Account</span>.
          </p>
        }
        cta={{ href: "/login", label: "Sign in →" }}
      />
    );
  }

  return (
    <Card
      title="Something went wrong"
      body={
        <p>
          We couldn&apos;t verify your email right now. Please try again in a
          minute or contact{" "}
          <a href="mailto:founder@braavolabs.com" style={{ color: "#00d1ff" }}>
            founder@braavolabs.com
          </a>
          .
        </p>
      }
      cta={{ href: "/login", label: "Back to sign in" }}
    />
  );
}

export default function VerifiedPage() {
  return (
    <Suspense fallback={<Card title="Verifying…" body={<p>Just a moment.</p>} />}>
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

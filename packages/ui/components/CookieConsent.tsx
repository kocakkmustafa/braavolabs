"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * Minimal KVKK/GDPR cookie consent banner.
 *
 * Decision is persisted in localStorage and never re-prompts on the same
 * device. Accepted choice surfaces as a `cookie_consent` key with one of
 * the values defined below — analytics integrations downstream can read
 * this to gate their loaders.
 *
 * Bağımlılık YOK — react-cookie-consent gibi paketlerin tek yaptığı bu
 * 30 satır + persistence; in-tree tutmak bundle size'ı koruyor.
 */
type Consent = "accepted" | "essential-only";
const STORAGE_KEY = "cookie_consent";

export function getCookieConsent(): Consent | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "accepted" || v === "essential-only" ? v : null;
  } catch {
    return null;
  }
}

export default function CookieConsent() {
  // null = not decided yet → show banner; string = decided → hide.
  const [consent, setConsent] = useState<Consent | null | "loading">("loading");

  useEffect(() => {
    setConsent(getCookieConsent());
  }, []);

  // SSR + first hydrate → render nothing to avoid layout flash. Real
  // banner only appears once we've checked localStorage on the client.
  if (consent === "loading" || consent !== null) return null;

  function decide(choice: Consent) {
    try {
      window.localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      /* private mode / disabled storage — banner just won't persist */
    }
    setConsent(choice);
  }

  return (
    <div
      role="dialog"
      aria-label="Cookie consent"
      aria-live="polite"
      style={{
        position: "fixed",
        bottom: 16,
        left: 16,
        right: 16,
        maxWidth: 720,
        margin: "0 auto",
        zIndex: 9999,
        background: "rgba(15, 19, 26, 0.96)",
        backdropFilter: "blur(8px)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 16,
        padding: "16px 20px",
        boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
        color: "#bbc9cf",
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <p style={{ margin: 0, color: "#e1e2eb", fontWeight: 600, marginBottom: 4 }}>
            Çerezler hakkında
          </p>
          <p style={{ margin: 0 }}>
            Braavolabs, oturum yönetimi ve servis güvenliği için zorunlu çerezler
            kullanır. İstersen anonim kullanım analitiğine de izin verebilirsin —
            kişisel veri toplamayız, IP'ler bile redact'lenir.{" "}
            <Link
              href="/privacy"
              style={{ color: "#a4e6ff", textDecoration: "underline" }}
            >
              Gizlilik Politikası
            </Link>
            .
          </p>
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            justifyContent: "flex-end",
          }}
        >
          <button
            type="button"
            onClick={() => decide("essential-only")}
            style={{
              padding: "8px 14px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.1)",
              background: "rgba(255,255,255,0.04)",
              color: "#bbc9cf",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Sadece zorunlu olanlar
          </button>
          <button
            type="button"
            onClick={() => decide("accepted")}
            style={{
              padding: "8px 14px",
              borderRadius: 10,
              border: "none",
              background: "linear-gradient(135deg, #00d1ff, #6d11ad)",
              color: "white",
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Hepsini kabul et
          </button>
        </div>
      </div>
    </div>
  );
}

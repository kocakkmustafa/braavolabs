"use client";

import { useLocale, useTranslations } from "next-intl";

export default function GdprPage() {
  // Page body stays English to match the supervisory-authority working
  // language; chrome localises and a banner notes the single-locale
  // design when a visitor arrives on a non-EN locale.
  const t = useTranslations();
  const locale = useLocale();
  const showBanner = locale !== "en";

  return (
    <div className="min-h-screen" style={{ background: "#0a0d14" }}>
      <nav
        className="flex items-center justify-between px-6 md:px-10 py-5 max-w-[1100px] mx-auto"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
      >
        <a href="/" className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
          >
            <span className="text-white font-bold text-xs">AI</span>
          </div>
          <span className="font-headline font-bold text-sm" style={{ color: "#e1e2eb" }}>Braavolabs</span>
        </a>
        <a href="/" className="text-sm hover:text-white transition-colors" style={{ color: "#859399" }}>{t("static.common.back")}</a>
      </nav>

      <div className="max-w-[720px] mx-auto px-6 py-16">
        {showBanner && (
          <div
            className="mb-8 p-4 rounded-xl text-xs"
            style={{ background: "rgba(0,209,255,0.04)", border: "1px solid rgba(0,209,255,0.15)", color: "#bbc9cf" }}
          >
            {t("static.singleLocale.gdprBanner")}
          </div>
        )}
        <div className="mb-10">
          <h1 className="font-headline font-extrabold mb-2" style={{ fontSize: "2rem", color: "#e1e2eb" }}>GDPR Statement</h1>
          <p className="text-sm" style={{ color: "#3c494e" }}>Last updated: May 2026</p>
        </div>

        <div className="space-y-8 text-sm leading-relaxed" style={{ color: "#859399" }}>
          {[
            { title: "Data Controller", body: "Braavolabs is the data controller for personal data processed through this platform. Contact: gdpr@braavolabs.com." },
            { title: "Personal Data We Process", body: "Identity data (name, email, organization name), account data (subscription status, billing history), usage data (pipeline run records, audit logs, IP, session ID), and payment metadata. We never store card details — Stripe handles them." },
            { title: "Lawful Bases", body: "Article 6(1)(b) contract performance for service delivery and billing. Article 6(1)(f) legitimate interest for security, fraud prevention, and product improvement. Article 6(1)(c) legal obligation for tax and accounting. Article 6(1)(a) consent for optional marketing communication." },
            { title: "Cross-Border Transfers", body: "Some processors are located outside the EEA: Stripe (US), SendGrid (US), HubSpot (US, optional), Google (US, optional), GitHub (US, optional). Transfers are governed by Standard Contractual Clauses (SCCs) per the European Commission's 2021 modules." },
            { title: "Your Rights", body: "You have the right to access, rectify, erase, restrict processing, port your data, object to processing, withdraw consent at any time, and lodge a complaint with your supervisory authority. To exercise any right, email gdpr@braavolabs.com — we respond within one month per Article 12(3)." },
            { title: "Retention", body: "Account data is retained while your account is active. Audit logs and run history are kept for 12 months. After account deletion, financial records are retained for the period required by tax law (typically 6–10 years depending on jurisdiction)." },
            { title: "Security", body: "We use TLS 1.3 in transit, AES-256 at rest, role-based access control on production systems, and regular security reviews. Breach notification per Article 33 is delivered within 72 hours of detection." },
            { title: "Data Protection Officer", body: "We have not appointed a formal DPO as we do not meet the Article 37 thresholds, but data protection inquiries are handled directly: gdpr@braavolabs.com." },
          ].map((section) => (
            <div key={section.title}>
              <h2 className="font-headline font-semibold text-sm mb-2" style={{ color: "#e1e2eb" }}>{section.title}</h2>
              <p>{section.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

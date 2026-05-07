"use client";

import { useTranslations } from "next-intl";

export default function ContactPage() {
  const t = useTranslations();
  // Stable channel keys + matching email addresses; per-locale labels
  // resolve at render time so the row copy translates while emails stay
  // the same.
  const channels = [
    { key: "General", email: "hello@braavolabs.com" },
    { key: "Support", email: "support@braavolabs.com" },
    { key: "Sales", email: "sales@braavolabs.com" },
    { key: "Privacy", email: "privacy@braavolabs.com" },
    { key: "Kvkk", email: "kvkk@braavolabs.com" },
    { key: "Security", email: "security@braavolabs.com" },
  ];

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
        <div className="mb-10">
          <h1 className="font-headline font-extrabold mb-2" style={{ fontSize: "2rem", color: "#e1e2eb" }}>{t("static.contact.title")}</h1>
          <p className="text-sm" style={{ color: "#3c494e" }}>{t("static.contact.subtitle")}</p>
        </div>

        <div className="space-y-3 text-sm">
          {channels.map((c) => (
            <div
              key={c.email}
              className="flex items-center justify-between px-4 py-3 rounded-xl"
              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}
            >
              <span style={{ color: "#bbc9cf" }}>{t(`static.contact.channel${c.key}`)}</span>
              <a href={`mailto:${c.email}`} className="transition-colors hover:opacity-80" style={{ color: "#a4e6ff" }}>
                {c.email}
              </a>
            </div>
          ))}
        </div>

        <p className="mt-10 text-xs" style={{ color: "#3c494e" }}>
          {t("static.contact.responseTime")}
        </p>
      </div>
    </div>
  );
}

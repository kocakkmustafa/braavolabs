"use client";

import { useTranslations } from "next-intl";
import LanguageSwitcher from "../../components/LanguageSwitcher";

export default function FeaturesPage() {
  const t = useTranslations();
  // Identifiers map to keys in messages/*.json under features.items.<id>
  // — title and desc come from i18n so the whole page localizes with a
  // single language switch. Icons and color tokens stay in code because
  // they're presentation, not content.
  const features = [
    { id: "agents", icon: "smart_toy", color: "#6d11ad" },
    { id: "memory", icon: "memory", color: "#00d1ff" },
    { id: "pipeline", icon: "account_tree", color: "#e0b6ff" },
    { id: "governance", icon: "security", color: "#f87171" },
    { id: "analytics", icon: "query_stats", color: "#a4e6ff" },
    { id: "billing", icon: "credit_card", color: "#34d399" },
    { id: "audit", icon: "history", color: "#fbbf24" },
    { id: "primitives", icon: "hub", color: "#00d1ff" },
    { id: "approval", icon: "task_alt", color: "#34d399" },
  ];

  return (
    <div className="min-h-screen" style={{ background: "#0a0d14" }}>
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 md:px-10 py-5 max-w-[1100px] mx-auto"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
        <a href="/" className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}>
            <span className="text-white font-bold text-xs">AI</span>
          </div>
          <span className="font-headline font-bold text-sm" style={{ color: "#e1e2eb" }}>Braavolabs</span>
        </a>
        <div className="flex items-center gap-4 text-sm" style={{ color: "#859399" }}>
          <a href="/pricing" className="hover:text-white transition-colors">{t("nav.pricing")}</a>
          <LanguageSwitcher />
          <a href="/login" className="px-4 py-2 rounded-xl font-semibold text-white text-xs transition-all hover:brightness-110"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}>
            {t("nav.getStarted")}
          </a>
        </div>
      </nav>

      <div className="max-w-[900px] mx-auto px-6 py-16">
        <div className="text-center mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full mb-5"
            style={{ border: "1px solid rgba(0,209,255,0.25)", background: "rgba(0,209,255,0.06)" }}>
            <span className="text-xs font-semibold tracking-widest" style={{ color: "#00d1ff" }}>{t("features.badge")}</span>
          </div>
          <h1 className="font-headline font-extrabold mb-4"
            style={{ fontSize: "clamp(2rem, 4vw, 3rem)", color: "#e1e2eb", lineHeight: 1.1 }}>
            {t("features.title")}
          </h1>
          <p style={{ color: "#859399", fontSize: "1rem", maxWidth: 480, margin: "0 auto" }}>
            {t("features.subtitle")}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map((f) => (
            <div key={f.id} className="p-5 rounded-2xl transition-all hover:scale-[1.01]"
              style={{ background: "rgba(29,32,38,0.7)", border: "1px solid rgba(255,255,255,0.05)" }}>
              <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-3"
                style={{ background: `${f.color}18` }}>
                <span className="material-symbols-outlined text-lg" style={{ color: f.color }}>{f.icon}</span>
              </div>
              <p className="font-headline font-bold text-sm mb-1.5" style={{ color: "#e1e2eb" }}>
                {t(`features.items.${f.id}.title`)}
              </p>
              <p className="text-xs leading-relaxed" style={{ color: "#859399" }}>
                {t(`features.items.${f.id}.desc`)}
              </p>
            </div>
          ))}
        </div>

        <div className="text-center mt-14">
          <a href="/login"
            className="inline-flex items-center gap-2 px-7 py-3 rounded-xl text-sm font-bold text-white transition-all hover:brightness-110"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", boxShadow: "0 0 24px rgba(0,209,255,0.2)" }}>
            <span className="material-symbols-outlined text-sm">rocket_launch</span>
            {t("features.ctaPrimary")}
          </a>
        </div>
      </div>
    </div>
  );
}

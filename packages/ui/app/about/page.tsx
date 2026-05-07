"use client";

import { useTranslations } from "next-intl";

export default function AboutPage() {
  const t = useTranslations();
  const sections = [1, 2, 3, 4] as const;

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
          <h1 className="font-headline font-extrabold mb-2" style={{ fontSize: "2rem", color: "#e1e2eb" }}>{t("static.about.title")}</h1>
          <p className="text-sm" style={{ color: "#3c494e" }}>{t("static.about.subtitle")}</p>
        </div>

        <div className="space-y-8 text-sm leading-relaxed" style={{ color: "#859399" }}>
          {sections.map((n) => (
            <section key={n}>
              <h2 className="font-headline font-semibold text-sm mb-2" style={{ color: "#e1e2eb" }}>{t(`static.about.section${n}Title`)}</h2>
              <p>{t(`static.about.section${n}Body`)}</p>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

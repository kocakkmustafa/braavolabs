"use client";

import { useTranslations } from "next-intl";

export default function ChangelogPage() {
  const t = useTranslations();
  // t.raw returns the unprocessed JSON value — required for arrays so we
  // can map over the items list without resorting to indexed key lookups.
  const items = t.raw("static.changelog.items") as string[];

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
          <h1 className="font-headline font-extrabold mb-2" style={{ fontSize: "2rem", color: "#e1e2eb" }}>{t("static.changelog.title")}</h1>
          <p className="text-sm" style={{ color: "#3c494e" }}>{t("static.changelog.subtitle")}</p>
        </div>

        <div className="space-y-6 text-sm" style={{ color: "#859399" }}>
          <article
            className="p-5 rounded-xl"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
          >
            <header className="flex items-baseline justify-between mb-3">
              <h2 className="font-headline font-semibold" style={{ color: "#e1e2eb" }}>{t("static.changelog.releaseTitle")}</h2>
              <time className="text-xs" style={{ color: "#3c494e" }}>{t("static.changelog.releaseDate")}</time>
            </header>
            <ul className="space-y-1.5 list-disc pl-5">
              {items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </article>

          <p className="text-center pt-4" style={{ color: "#3c494e" }}>
            {t("static.changelog.githubIntro")}{" "}
            <a
              href="https://github.com/kocakkmustafa/braavolabs/releases"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:opacity-80"
              style={{ color: "#a4e6ff" }}
            >
              github.com/kocakkmustafa/braavolabs/releases
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

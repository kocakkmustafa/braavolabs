
import { useTranslations as useRuntimeTranslations } from "next-intl";
import { getTranslations as getSeoTranslations } from "next-intl/server";

import { useTranslations as useLegacyTranslations } from "next-intl";
/**
 * Public support landing page.
 *
 * Required by:
 * - Apple App Store Guideline 1.5: the Support URL in App Store Connect
 *   must resolve to a functional webpage with support information.
 *   ASC points at braavolabs.com/destek which 301s here (next.config.ts).
 * - Google Play store listing support expectations.
 *
 * Linked from the marketing footer and listed in sitemap.ts.
 */

import type { Metadata } from "next";
import { brandTitle } from "../../lib/brand-title";

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSeoTranslations("seo");
  return {
  title: brandTitle(seo("m371d913a6d14")),
  description:
    seo("m43f347f64d40"),
  alternates: { canonical: "https://www.braavolabs.com/support" },
  openGraph: {
    title: seo("me4c0f5357766"),
    description:
      seo("mee5a52d3051f"),
    url: "https://www.braavolabs.com/support",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};
}



export default function SupportPage() {
  const runtimeCopy = useRuntimeTranslations("runtime");
  const uiText = useLegacyTranslations("uiCopy");
  const copy = useLegacyTranslations("surface.support");
  const sections = [
    {
      id: "contact",
      title: runtimeCopy("m7034fec532bb"),
      icon: "support_agent",
      content: (
        <>
          <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">{copy("emailIntro")}{" "}
            <a
              href="mailto:support@braavolabs.com"
              className="text-primary underline hover:text-primary-fixed transition-colors"
            >
              support@braavolabs.com
            </a>{" "}{copy("responseTime")}{" "}
            <a href="/contact" className="text-primary underline hover:text-primary-fixed transition-colors">{uiText("m89dc05ffd2b2")}</a>{" "}{uiText("m083a2705391c")}</p>
          <ul className="text-[15.5px] leading-[1.8] text-on-surface-variant pl-[22px] list-disc mb-[18px] space-y-2">
            <li>
              <strong className="text-on-surface font-medium">{uiText("m366977224408")}</strong> —{" "}
              <a href="mailto:support@braavolabs.com" className="text-primary underline hover:text-primary-fixed transition-colors">
                support@braavolabs.com
              </a>
            </li>
            <li>
              <strong className="text-on-surface font-medium">{uiText("m8cb8b49fe281")}</strong> —{" "}
              <a href="mailto:privacy@braavolabs.com" className="text-primary underline hover:text-primary-fixed transition-colors">
                privacy@braavolabs.com
              </a>
            </li>
            <li>
              <strong className="text-on-surface font-medium">{uiText("m771454b72f87")}</strong> —{" "}
              <a href="mailto:security@braavolabs.com" className="text-primary underline hover:text-primary-fixed transition-colors">
                security@braavolabs.com
              </a>
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "subscriptions",
      title: runtimeCopy("m34f6a807aeb9"),
      icon: "subscriptions",
      content: (
        <>
          <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">{uiText("m97ffe5296db2")}{" "}
            <strong className="text-on-surface font-medium">{uiText("m1fc91bf085eb")}</strong>{uiText("md62504ec7e39")}{" "}<strong className="text-on-surface font-medium">{uiText("mb71b1e7e1c1e")}</strong>{uiText("m9ad3281dcc2d")}{" "}<strong className="text-on-surface font-medium">{uiText("m9b8015792921")}</strong>{" "}{uiText("mfa4b446e8ff6")}</p>
        </>
      ),
    },
    {
      id: "faq",
      title: runtimeCopy("m616706013792"),
      icon: "quiz",
      content: (
        <>
          <ul className="text-[15.5px] leading-[1.8] text-on-surface-variant pl-[22px] list-disc mb-[18px] space-y-2">
            <li><strong className="text-on-surface font-medium">{uiText("mdb4dc1cc9096")}</strong>{" "}{uiText("ma6211b5db44c")}</li>
            <li><strong className="text-on-surface font-medium">{uiText("m8e6535637cb8")}</strong>{" "}{runtimeCopy("providerKeys")}</li>
            <li><strong className="text-on-surface font-medium">{uiText("me8234ddd08d0")}</strong>{" "}<a href="/legal/account-deletion" className="text-primary underline hover:text-primary-fixed transition-colors">{uiText("m301aee668176")}</a></li>
            <li><strong className="text-on-surface font-medium">{uiText("m3cb779dfce49")}</strong>{" "}<a href="/status" className="text-primary underline hover:text-primary-fixed transition-colors">{uiText("m652cc7ed28eb")}</a></li>
          </ul>
        </>
      ),
    },
    {
      id: "report-a-problem",
      title: runtimeCopy("me01516c0ee66"),
      icon: "bug_report",
      content: (
        <>
          <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">{uiText("mb29ed7325631")}{" "}
            <a
              href="mailto:support@braavolabs.com?subject=Bug%20report"
              className="text-primary underline hover:text-primary-fixed transition-colors"
            >
              support@braavolabs.com
            </a>{" "}{uiText("mc878475dd7ed")}{" "}
            <strong className="text-on-surface font-medium">{uiText("m3dbf7d618644")}</strong>{uiText("mb142b8b38188")}</p>
        </>
      ),
    },
    {
      id: "legal",
      title: runtimeCopy("me4b47da679e8"),
      icon: "gavel",
      content: (
        <>
          <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">{uiText("ma16f308c1827")}{" "}
            <a href="/privacy" className="text-primary underline hover:text-primary-fixed transition-colors">{uiText("mf5be8b9e2a4f")}</a>
            ,{" "}
            <a href="/terms" className="text-primary underline hover:text-primary-fixed transition-colors">{uiText("m337507465f44")}</a>
            ,{" "}
            <a href="/gdpr" className="text-primary underline hover:text-primary-fixed transition-colors">{uiText("m7ba5c42d05d5")}</a>
            ,{" "}
            <a href="/kvkk" className="text-primary underline hover:text-primary-fixed transition-colors">{uiText("mc8d0aedb0025")}</a>{" "}{uiText("m668b03bf599d")}{" "}
            <a href="/legal/account-deletion" className="text-primary underline hover:text-primary-fixed transition-colors">{uiText("m981862dbff04")}</a>{" "}{uiText("m7ec4811747eb")}</p>
        </>
      ),
    },
  ];

  return (
    <div className="min-h-screen bg-background bv-mesh">
      {/* ── Nav ── */}
      <nav className="sticky top-0 z-40 border-b border-outline-variant bg-surface/80 backdrop-blur-xl">
        <div className="max-w-[1100px] mx-auto flex flex-wrap gap-y-2 items-center justify-between px-6 md:px-10 min-h-14 py-2 md:py-0">
          <a href="/" className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bv-btn-primary bv-btn">
              <span className="text-white font-bold text-xs leading-none">AI</span>
            </div>
            <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
          </a>
          <div className="order-last basis-full flex overflow-x-auto whitespace-nowrap pb-1 md:order-none md:basis-auto md:overflow-visible md:pb-0 items-center gap-6">
            <a href="/features" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">{uiText("maf2d75b446d2")}</a>
            <a href="/pricing" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">{uiText("mf11c295fe6b2")}</a>
            <a href="/about" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">{uiText("ma046b81f5cad")}</a>
          </div>
          <div className="flex items-center gap-3">
            <a href="https://app.braavolabs.com/login" className="bv-btn bv-btn-ghost bv-btn-sm text-sm">{uiText("ma833a458dc85")}</a>
            <a href="https://app.braavolabs.com" className="bv-btn bv-btn-primary bv-btn-sm text-sm">{uiText("mdc1d31161f04")}</a>
          </div>
        </div>
      </nav>

      {/* ── Page header ── */}
      <header className="relative text-center pt-[clamp(56px,8vw,90px)] pb-10 overflow-hidden">
        <div className="relative max-w-[1100px] mx-auto px-6">
          <div className="flex items-center justify-center gap-2 mb-4">
            <span className="bv-pill bv-pill-cyan">
              <span className="material-symbols-outlined" style={{ fontSize: 12 }}>support_agent</span>{uiText("m0a40adc25a52")}</span>
          </div>

          <h1 className="font-headline font-semibold uppercase tracking-tight text-on-surface text-[clamp(34px,5vw,60px)] leading-[1.05] mb-3">{uiText("mefb78ad514f6")}</h1>
          <p className="text-on-surface-variant max-w-[60ch] mx-auto">{copy("intro")}</p>

          <div className="flex flex-wrap justify-center gap-3 mt-8">
            <a href="mailto:support@braavolabs.com" className="bv-btn bv-btn-primary bv-btn-sm">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>mail</span>{uiText("m0dff0c2e8740")}</a>
            <a href="/contact" className="bv-btn bv-btn-ghost bv-btn-sm">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>edit_note</span>{uiText("mdc8b49376a22")}</a>
            <a href="/status" className="bv-btn bv-btn-ghost bv-btn-sm">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>monitor_heart</span>{uiText("m5368a784c155")}</a>
          </div>
        </div>
      </header>

      {/* ── Article grid (TOC + prose) ── */}
      <div className="max-w-[1040px] mx-auto px-6 md:px-8 mt-10 mb-24 grid grid-cols-1 md:grid-cols-[230px_1fr] gap-12">
        {/* Sticky TOC (desktop) */}
        <nav className="hidden md:block sticky top-[72px] self-start" aria-label={uiText("m57cd0c28916e")}>
          <p className="bv-micro mb-[14px]">{uiText("m57cd0c28916e")}</p>
          <div className="flex flex-col">
            {sections.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="text-[13px] leading-[1.3] text-on-surface-variant hover:text-on-surface py-[7px] px-[14px] border-l-2 border-outline-variant hover:border-primary transition-all"
              >
                {s.title}
              </a>
            ))}
          </div>
        </nav>

        {/* Prose */}
        <article className="max-w-[72ch] pb-24 bv-stagger">
          {sections.map((s) => (
            <section key={s.id} id={s.id} className="mb-0 scroll-mt-[90px]">
              <div className="bv-divider my-9 first:hidden" />

              <h2 className="font-headline font-semibold text-2xl uppercase tracking-tight text-on-surface mb-[14px] flex items-center gap-[10px] group">
                <span
                  className="material-symbols-outlined text-outline text-[20px] flex-shrink-0"
                  aria-hidden="true"
                >
                  {s.icon}
                </span>
                <span>{s.title}</span>
                <a
                  href={`#${s.id}`}
                  className="opacity-0 group-hover:opacity-100 text-[15px] text-primary no-underline transition-opacity"
                  aria-label={runtimeCopy("m8e94897c7807", { value0: s.title })}
                >
                  ¶
                </a>
              </h2>

              {s.content}
            </section>
          ))}

          {/* CTA card */}
          <div className="mt-10 bv-glass p-6 flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div className="flex-1">
              <p className="bv-title mb-1">{uiText("m97e6379af81c")}</p>
              <p className="bv-caption">{uiText("m4a375a6c78be")}</p>
            </div>
            <div className="flex gap-3 flex-shrink-0">
              <a href="mailto:support@braavolabs.com" className="bv-btn bv-btn-primary bv-btn-sm">
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>mail</span>
                support@braavolabs.com
              </a>
            </div>
          </div>
        </article>
      </div>

      {/* ── Footer ── */}
      <footer className="border-t border-outline-variant">
        <div className="max-w-[1100px] mx-auto px-6 md:px-10 py-12">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-10">
            <div className="col-span-2 md:col-span-1">
              <a href="/" className="flex items-center gap-2.5 mb-3">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center bv-btn-primary bv-btn bv-btn-icon" style={{ padding: 0, minWidth: 28, minHeight: 28, width: 28, height: 28 }}>
                  <span className="text-white font-bold text-[10px] leading-none">AI</span>
                </div>
                <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
              </a>
              <p className="text-sm text-on-surface-variant leading-relaxed">{uiText("m69772795df01")}</p>
            </div>
            <div>
              <h5 className="bv-micro mb-3">{uiText("m691ce9b2c824")}</h5>
              <div className="flex flex-col gap-2">
                <a href="/features" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">{uiText("maf2d75b446d2")}</a>
                <a href="/pricing" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">{uiText("mf11c295fe6b2")}</a>
                <a href="/changelog" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">{uiText("mb7d1cacaa4dc")}</a>
              </div>
            </div>
            <div>
              <h5 className="bv-micro mb-3">{uiText("m43dbdbcb4213")}</h5>
              <div className="flex flex-col gap-2">
                <a href="/about" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">{uiText("ma046b81f5cad")}</a>
                <a href="/blog" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">{uiText("m0fb5d8aef58c")}</a>
                <a href="/contact" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">{uiText("md17c12c62307")}</a>
              </div>
            </div>
            <div>
              <h5 className="bv-micro mb-3">{uiText("m29dff0f6e658")}</h5>
              <div className="flex flex-col gap-2">
                <a href="/privacy" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">{uiText("mb8ffce79447d")}</a>
                <a href="/terms" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">{uiText("mb295f0dd3165")}</a>
                <a href="/kvkk" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">KVKK</a>
                <a href="/gdpr" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">GDPR</a>
              </div>
            </div>
          </div>
          <div className="bv-divider" />
          <p className="text-sm text-outline mt-6 text-center">
            &copy; {new Date().getFullYear()}{" "}{uiText("m61c5cf9b820b")}</p>
        </div>
      </footer>
    </div>
  );
}

import { getTranslations as getSeoTranslations } from "next-intl/server";

import { useTranslations as useLegacyTranslations } from "next-intl";
import type { Metadata } from "next";
import { brandTitle } from "../../lib/brand-title";

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSeoTranslations("seo");
  return {
  title: brandTitle(seo("m8931468be759")),
  description: seo("m4fc24ac37ec4"),
  alternates: { canonical: "https://www.braavolabs.com/security" },
  openGraph: {
    title: seo("m8931468be759"),
    description: seo("m4fc24ac37ec4"),
    url: "https://www.braavolabs.com/security",
  },
};
}

const RAW_BOUNDARIES = [
  {
    title: "Inference boundary",
    copy: "Inference is not included. Use your own provider keys (BYOK) or local models.",
  },
  {
    title: "Approval boundary",
    copy: "Money-touching actions require explicit approval. Exact-action approval — in development — is the planned broader binding contract.",
  },
  {
    title: "Public/auth boundary",
    copy: "The public site serves product information. Accounts, tenant routes, and operational APIs belong to the authenticated app and API hosts.",
  },
  {
    title: "Certification boundary",
    copy: "We do not display a certification badge until the certification is held and independently verifiable.",
  },
] as const;

export default function SecurityPage() {
  const dataCopy = useLegacyTranslations("dataCopy");
  const BOUNDARIES = RAW_BOUNDARIES.map((entry, index) => ({ ...entry, title: dataCopy.raw(`securityBoundaries.${index}.title`) as string, copy: dataCopy.raw(`securityBoundaries.${index}.copy`) as string }));
  const uiText = useLegacyTranslations("uiCopy");
  return (
    <div className="min-h-screen bv-mesh" data-public-surface="security">
      <nav className="border-b border-outline-variant bg-surface/80 backdrop-blur-xl">
        <div className="max-w-[1040px] mx-auto px-6 h-16 flex items-center justify-between gap-5">
          <a href="/" className="font-headline font-bold no-underline">Braavolabs</a>
          <div className="flex items-center gap-3">
            <a href="/docs" className="hidden sm:inline text-sm text-on-surface-variant no-underline">{uiText("m6519c809652c")}</a>
            <a href="https://app.braavolabs.com/login" className="bv-btn bv-btn-ghost bv-btn-sm no-underline">{uiText("ma280e8530c88")}</a>
            <a href="https://app.braavolabs.com/register" className="bv-btn bv-btn-primary bv-btn-sm no-underline">{uiText("m0c1bf711335e")}</a>
          </div>
        </div>
      </nav>

      <main className="max-w-[1040px] mx-auto px-6 py-20">
        <header className="max-w-[760px]">
          <p className="bv-pill bv-pill-cyan inline-flex mb-5">{uiText("m0b84272e0b38")}</p>
          <h1 className="font-headline font-bold uppercase text-[clamp(40px,7vw,74px)] leading-[0.95]">{uiText("m2708222253e6")}</h1>
          <p className="text-on-surface-variant text-lg mt-6 leading-relaxed">{uiText("mf6cd2e305a08")}</p>
        </header>

        <section className="grid md:grid-cols-2 gap-5 mt-14">
          {BOUNDARIES.map((boundary) => (
            <article key={boundary.title} className="bv-glass p-7">
              <h2 className="font-headline font-semibold text-2xl">{boundary.title}</h2>
              <p className="text-on-surface-variant mt-3 leading-relaxed">{boundary.copy}</p>
            </article>
          ))}
        </section>

        <section className="grid md:grid-cols-2 gap-5 mt-5">
          <article className="bv-glass p-7">
            <h2 className="font-headline font-semibold text-xl">{uiText("m87d3344f51c0")}</h2>
            <p className="text-on-surface-variant mt-3 leading-relaxed">{uiText("m7ed0edec682e")}</p>
          </article>
          <article className="bv-glass p-7">
            <h2 className="font-headline font-semibold text-xl">{uiText("me5d088788752")}</h2>
            <p className="text-on-surface-variant mt-3 leading-relaxed">{uiText("m6e5d8b8e7120")}</p>
          </article>
        </section>

        <section className="bv-glass p-7 mt-5">
          <h2 className="font-headline font-semibold text-xl">{uiText("m82cfde8eb7cd")}</h2>
          <p className="text-on-surface-variant mt-3">{uiText("mc63ed84605c0")}</p>
        </section>

        <div className="flex flex-wrap gap-3 mt-10">
          <a href="https://app.braavolabs.com/dashboard" className="bv-btn bv-btn-primary no-underline">{uiText("m16ca86ca2649")}</a>
          <a href="mailto:security@braavolabs.com" className="bv-btn bv-btn-ghost no-underline">{uiText("m7945cffa32f0")}</a>
        </div>
      </main>
    </div>
  );
}

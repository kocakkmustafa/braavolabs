import { getTranslations as getSeoTranslations } from "next-intl/server";

import { useTranslations as useLegacyTranslations } from "next-intl";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSeoTranslations("seo");
  return {
  title: seo("m804e9858225a"),
  description: seo("mcb18970cc53a"),
  alternates: { canonical: "https://www.braavolabs.com/features" },
  openGraph: {
    title: seo("m804e9858225a"),
    description: seo("mcb18970cc53a"),
    url: "https://www.braavolabs.com/features",
  },
};
}

const RAW_CAPABILITIES = [
  {
    label: "Run",
    title: "Cross-vendor workbench",
    copy: "Coordinate model and agent work without turning one vendor runtime into the control plane.",
  },
  {
    label: "Control",
    title: "Exact-action approval — in development",
    copy: "The broader action, scope, expiry, and execution-context binding contract is planned and is not presented as generally available.",
  },
  {
    label: "Conversation",
    title: "Resume and steer",
    copy: "Keep ordered turns, tool actions, artifacts, and remote operator input in the same run context.",
  },
  {
    label: "Models",
    title: "BYOK and local choice",
    copy: "Select a model route explicitly and keep provider cost on your own keys or local runtime.",
  },
] as const;

export default function FeaturesPage() {
  const dataCopy = useLegacyTranslations("dataCopy");
  const CAPABILITIES = RAW_CAPABILITIES.map((entry, index) => ({ ...entry, label: dataCopy.raw(`capabilities.${index}.label`) as string, title: dataCopy.raw(`capabilities.${index}.title`) as string, copy: dataCopy.raw(`capabilities.${index}.copy`) as string }));
  const uiText = useLegacyTranslations("uiCopy");
  return (
    <div className="min-h-screen bv-mesh" data-public-surface="features">
      <nav className="border-b border-outline-variant bg-surface/80 backdrop-blur-xl">
        <div className="max-w-[1080px] mx-auto px-6 h-16 flex items-center justify-between gap-5">
          <a href="/" className="font-headline font-bold no-underline">Braavolabs</a>
          <div className="flex items-center gap-3">
            <a href="/pricing" className="hidden sm:inline text-sm text-on-surface-variant no-underline">{uiText("m12cc6cbe8456")}</a>
            <a href="https://app.braavolabs.com/login" className="bv-btn bv-btn-ghost bv-btn-sm no-underline">{uiText("md2d886d00f8d")}</a>
            <a href="https://app.braavolabs.com/register" className="bv-btn bv-btn-primary bv-btn-sm no-underline">{uiText("m5622cdb1d573")}</a>
          </div>
        </div>
      </nav>

      <main className="max-w-[1080px] mx-auto px-6 py-20">
        <header className="max-w-[760px]">
          <p className="bv-pill bv-pill-cyan inline-flex mb-5">{uiText("mb92a5ff6a3f6")}</p>
          <h1 className="font-headline font-bold uppercase text-[clamp(40px,7vw,76px)] leading-[0.95]">{uiText("md8d7b7db0cdd")}</h1>
          <p className="text-on-surface-variant text-lg mt-6 leading-relaxed">{uiText("m5c19d5d0e672")}</p>
        </header>

        <section className="grid md:grid-cols-2 gap-5 mt-14">
          {CAPABILITIES.map((capability) => (
            <article key={capability.title} className="bv-glass p-7">
              <p className="bv-micro text-primary mb-3">{capability.label}</p>
              <h2 className="font-headline font-semibold text-2xl">{capability.title}</h2>
              <p className="text-on-surface-variant mt-3 leading-relaxed">{capability.copy}</p>
            </article>
          ))}
        </section>

        <section className="grid md:grid-cols-2 gap-5 mt-5">
          <article className="bv-glass p-7">
            <p className="bv-micro text-primary mb-3">{uiText("md530d8e09e2a")}</p>
            <p className="text-on-surface-variant leading-relaxed">{uiText("mc015473cee7b")}</p>
          </article>
          <article className="bv-glass p-7">
            <p className="bv-micro text-primary mb-3">{uiText("m99e52a77109d")}</p>
            <p className="text-on-surface-variant leading-relaxed">{uiText("m4be5a94fd7e3")}</p>
          </article>
        </section>

        <section className="bv-glass p-7 mt-5 grid md:grid-cols-2 gap-8">
          <div>
            <h2 className="font-headline font-semibold text-xl">{uiText("m538495414df0")}</h2>
            <p className="text-on-surface-variant mt-2">{uiText("m283b1bddd62f")}</p>
          </div>
          <div>
            <h2 className="font-headline font-semibold text-xl">{uiText("mc7577ef44a73")}</h2>
            <p className="text-on-surface-variant mt-2">{uiText("mf457eb5a3ed1")}</p>
          </div>
        </section>

        <div className="flex flex-wrap gap-3 mt-10">
          <a href="https://app.braavolabs.com/dashboard" className="bv-btn bv-btn-primary no-underline">{uiText("m9f5b1afe44a4")}</a>
          <a href="/docs" className="bv-btn bv-btn-ghost no-underline">{uiText("m3129e7d997e9")}</a>
        </div>
      </main>
    </div>
  );
}

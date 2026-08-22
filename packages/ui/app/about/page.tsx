import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About Braavolabs",
  description: "Braavolabs is a cross-vendor AI workbench and control plane built around explicit operator control.",
  alternates: { canonical: "https://www.braavolabs.com/about" },
  openGraph: {
    title: "About Braavolabs",
    description: "Braavolabs is a cross-vendor AI workbench and control plane built around explicit operator control.",
    url: "https://www.braavolabs.com/about",
  },
};

const PRINCIPLES = [
  {
    title: "Cross-vendor by design",
    body: "The workbench coordinates supported provider and local model routes without presenting one model vendor as the control plane.",
  },
  {
    title: "Control stays explicit",
    body: "Model route, data mode, and approval scope remain visible operator choices instead of hidden defaults.",
  },
  {
    title: "Maturity stays visible",
    body: "Holding is a premium/private preview, and signed evidence is in development until its verification contract is accepted.",
  },
] as const;

export default function AboutPage() {
  return (
    <div className="min-h-screen bv-mesh" data-public-surface="about">
      <nav className="border-b border-outline-variant bg-surface/80 backdrop-blur-xl">
        <div className="max-w-[1040px] mx-auto px-6 h-16 flex items-center justify-between gap-5">
          <a href="/" className="font-headline font-bold no-underline">Braavolabs</a>
          <div className="flex items-center gap-3">
            <a href="/docs" className="hidden sm:inline text-sm text-on-surface-variant no-underline">Docs</a>
            <a href="https://app.braavolabs.com/login" className="bv-btn bv-btn-ghost bv-btn-sm no-underline">Sign in</a>
            <a href="https://app.braavolabs.com/register" className="bv-btn bv-btn-primary bv-btn-sm no-underline">Choose a plan</a>
          </div>
        </div>
      </nav>

      <main id="main-content" className="max-w-[1040px] mx-auto px-6 py-20">
        <header className="max-w-[760px]">
          <p className="bv-pill bv-pill-cyan inline-flex mb-5">About Braavolabs</p>
          <h1 className="font-headline font-bold uppercase text-[clamp(40px,7vw,76px)] leading-[0.95]">
            AI work across vendors, under human control.
          </h1>
          <p className="text-on-surface-variant text-lg mt-6 leading-relaxed">
            Braavolabs is a cross-vendor AI workbench and control plane spanning desktop, CLI, mobile,
            and an authenticated cloud product. The public site explains that contract; it does not render tenant work.
          </p>
        </header>

        <section className="grid md:grid-cols-3 gap-5 mt-14">
          {PRINCIPLES.map((principle) => (
            <article key={principle.title} className="bv-glass p-7">
              <h2 className="font-headline font-semibold text-xl">{principle.title}</h2>
              <p className="text-on-surface-variant mt-3 leading-relaxed">{principle.body}</p>
            </article>
          ))}
        </section>

        <section className="bv-glass p-8 mt-6">
          <h2 className="font-headline font-semibold text-2xl">Bring the model route</h2>
          <p className="text-on-surface-variant mt-3">
            Inference is not included. Use your own provider keys (BYOK) or local models.
          </p>
          <div className="flex flex-wrap gap-3 mt-6">
            <a href="/pricing" className="bv-btn bv-btn-ghost no-underline">Review pricing</a>
            <a href="https://app.braavolabs.com/register" className="bv-btn bv-btn-primary no-underline">Create an account</a>
          </div>
        </section>
      </main>
    </div>
  );
}

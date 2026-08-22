import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Security — Braavolabs",
  description: "Braavolabs security boundaries for model keys, data modes, approval, and product maturity.",
  alternates: { canonical: "https://www.braavolabs.com/security" },
  openGraph: {
    title: "Security — Braavolabs",
    description: "Braavolabs security boundaries for model keys, data modes, approval, and product maturity.",
    url: "https://www.braavolabs.com/security",
  },
};

const BOUNDARIES = [
  {
    title: "Inference boundary",
    copy: "Inference is not included. Use your own provider keys (BYOK) or local models.",
  },
  {
    title: "Approval boundary",
    copy: "Money-touching actions require explicit approval; broader exact-action binding is part of the governed control contract.",
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
  return (
    <div className="min-h-screen bv-mesh" data-public-surface="security">
      <nav className="border-b border-outline-variant bg-surface/80 backdrop-blur-xl">
        <div className="max-w-[1040px] mx-auto px-6 h-16 flex items-center justify-between gap-5">
          <a href="/" className="font-headline font-bold no-underline">Braavolabs</a>
          <div className="flex items-center gap-3">
            <a href="/docs" className="hidden sm:inline text-sm text-on-surface-variant no-underline">Docs</a>
            <a href="https://app.braavolabs.com/login" className="bv-btn bv-btn-ghost bv-btn-sm no-underline">Sign in</a>
            <a href="https://app.braavolabs.com/register" className="bv-btn bv-btn-primary bv-btn-sm no-underline">Sign up</a>
          </div>
        </div>
      </nav>

      <main className="max-w-[1040px] mx-auto px-6 py-20">
        <header className="max-w-[760px]">
          <p className="bv-pill bv-pill-cyan inline-flex mb-5">Security and trust</p>
          <h1 className="font-headline font-bold uppercase text-[clamp(40px,7vw,74px)] leading-[0.95]">Boundaries, stated plainly.</h1>
          <p className="text-on-surface-variant text-lg mt-6 leading-relaxed">
            Public security copy is limited to contracts the product can test. Roadmap direction is labelled as such,
            and release claims wait for accepted evidence.
          </p>
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
            <h2 className="font-headline font-semibold text-xl">Private Mode</h2>
            <p className="text-on-surface-variant mt-3 leading-relaxed">
              Private Mode keeps prompt, output, and artifact content end-to-end encrypted so Braavolabs cloud cannot read the plaintext.
            </p>
          </article>
          <article className="bv-glass p-7">
            <h2 className="font-headline font-semibold text-xl">Cloud Agent Mode</h2>
            <p className="text-on-surface-variant mt-3 leading-relaxed">
              Cloud Agent Mode processes the content needed to run the task in Braavolabs execution infrastructure with explicit consent and visible retention.
            </p>
          </article>
        </section>

        <section className="bv-glass p-7 mt-5">
          <h2 className="font-headline font-semibold text-xl">Signed evidence — in development</h2>
          <p className="text-on-surface-variant mt-3">
            Activity records are not presented as an offline-verifiable signed evidence bundle until that contract is implemented and accepted.
          </p>
        </section>

        <div className="flex flex-wrap gap-3 mt-10">
          <a href="https://app.braavolabs.com/dashboard" className="bv-btn bv-btn-primary no-underline">Launch app</a>
          <a href="mailto:security@braavolabs.com" className="bv-btn bv-btn-ghost no-underline">Report a security issue</a>
        </div>
      </main>
    </div>
  );
}

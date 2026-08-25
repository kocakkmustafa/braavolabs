import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Braavolabs — Cross-vendor AI control",
  description:
    "A cross-vendor AI workbench and control plane with explicit approvals, BYOK or local inference, and clear data-mode boundaries.",
  alternates: { canonical: "https://www.braavolabs.com" },
  openGraph: {
    title: "Braavolabs — Cross-vendor AI control",
    description:
      "Run and control AI work across vendors while keeping model choice, spend approval, and data mode explicit.",
    url: "https://www.braavolabs.com",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

const MODES = [
  {
    name: "Private Mode — preview",
    copy: "Its complete data-handling and security contract remains in development and is not presented as generally available.",
  },
  {
    name: "Cloud Agent Mode — in development",
    copy: "Its execution, consent, and retention contract is not presented as generally available.",
  },
];

const PUBLIC_LINKS = [
  ["Features", "/features"],
  ["Pricing", "/pricing"],
  ["Security", "/security"],
  ["Docs", "/docs"],
  ["CLI availability", "/docs/getting-started"],
  ["Status", "/status"],
  ["Support", "/support"],
] as const;

export default function HomePage() {
  return (
    <div className="min-h-screen bv-mesh" data-public-surface="marketing">
      <nav className="sticky top-0 z-40 border-b border-outline-variant bg-surface/80 backdrop-blur-xl">
        <div className="max-w-[1120px] mx-auto px-6 h-16 flex items-center justify-between gap-6">
          <a href="/" className="font-headline font-bold text-on-surface no-underline">
            Braavolabs
          </a>
          <div className="hidden lg:flex items-center gap-5 text-sm text-on-surface-variant">
            {PUBLIC_LINKS.slice(0, 5).map(([label, href]) => (
              <a key={href} href={href} className="hover:text-on-surface transition-colors no-underline">
                {label}
              </a>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <a href="https://app.braavolabs.com/login" className="bv-btn bv-btn-ghost bv-btn-sm no-underline">
              Sign in
            </a>
            <a href="https://app.braavolabs.com/register" className="bv-btn bv-btn-primary bv-btn-sm no-underline">
              Sign up
            </a>
          </div>
        </div>
      </nav>

      <main>
        <section className="max-w-[1120px] mx-auto px-6 pt-24 pb-16 text-center">
          <p className="bv-pill bv-pill-cyan inline-flex mb-6">Public product preview</p>
          <h1 className="font-headline font-bold uppercase tracking-tight text-[clamp(42px,8vw,88px)] leading-[0.92]">
            Cross-vendor AI,
            <br />
            under your control.
          </h1>
          <p className="text-on-surface-variant text-lg max-w-[65ch] mx-auto mt-7 leading-relaxed">
            Braavolabs is a cross-vendor AI workbench and control plane for governed runs, explicit actions,
            model choice, and human approval across desktop, CLI, mobile, and cloud surfaces.
          </p>
          <div className="flex flex-wrap justify-center gap-3 mt-9">
            <a href="https://app.braavolabs.com/dashboard" className="bv-btn bv-btn-primary no-underline">
              Launch app
            </a>
            <a href="/docs" className="bv-btn bv-btn-ghost no-underline">
              Read docs
            </a>
          </div>
        </section>

        <section className="max-w-[1120px] mx-auto px-6 pb-16" aria-labelledby="planned-pricing">
          <p className="text-center bv-micro text-primary mb-3">Pricing preview — not currently purchasable</p>
          <h2 id="planned-pricing" className="sr-only">Planned pricing</h2>
          <div className="grid md:grid-cols-2 gap-5">
            <article className="bv-glass p-7">
              <p className="bv-micro text-primary mb-3">Individual</p>
              <h2 className="font-headline font-semibold text-3xl">Individual — $19/month</h2>
              <p className="text-on-surface-variant mt-3">One user, with the same model and data-mode choice.</p>
            </article>
            <article className="bv-glass p-7">
              <p className="bv-micro text-primary mb-3">Team</p>
              <h2 className="font-headline font-semibold text-3xl">Team — $39/active-user/month</h2>
              <p className="text-on-surface-variant mt-3">Users share workspace policy and approvals.</p>
            </article>
          </div>
          <p className="text-center text-on-surface-variant mt-5">
            Inference is not included. Use your own provider keys (BYOK) or local models.
          </p>
        </section>

        <section className="max-w-[1120px] mx-auto px-6 pb-16">
          <div className="grid md:grid-cols-2 gap-5">
            {MODES.map((mode) => (
              <article key={mode.name} className="bv-glass p-7">
                <p className="bv-micro text-primary mb-3">Data mode</p>
                <h2 className="font-headline font-semibold text-2xl">{mode.name}</h2>
                <p className="text-on-surface-variant mt-3 leading-relaxed">{mode.copy}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="max-w-[1120px] mx-auto px-6 pb-24">
          <div className="bv-glass p-7 grid md:grid-cols-2 gap-8">
            <div>
              <p className="bv-micro text-primary mb-3">Maturity</p>
              <h2 className="font-headline font-semibold text-2xl">Holding — premium/private preview</h2>
              <p className="text-on-surface-variant mt-3">Persistent-agent packaging is not part of the public plans.</p>
            </div>
            <div>
              <p className="bv-micro text-primary mb-3">Verification</p>
              <h2 className="font-headline font-semibold text-2xl">Signed evidence — in development</h2>
              <p className="text-on-surface-variant mt-3">Public offline-verification claims wait for accepted evidence.</p>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-outline-variant">
        <div className="max-w-[1120px] mx-auto px-6 py-10 flex flex-wrap items-center justify-between gap-5 text-sm">
          <span className="text-on-surface-variant">© 2026 Braavolabs</span>
          <div className="flex flex-wrap gap-5">
            {PUBLIC_LINKS.slice(5).map(([label, href]) => (
              <a key={href} href={href} className="text-on-surface-variant hover:text-on-surface no-underline">
                {label}
              </a>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}

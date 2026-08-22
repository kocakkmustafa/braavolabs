import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Features — Braavolabs",
  description: "The public Braavolabs product contract across run, control, data mode, and verification surfaces.",
  alternates: { canonical: "https://www.braavolabs.com/features" },
  openGraph: {
    title: "Features — Braavolabs",
    description: "The public Braavolabs product contract across run, control, data mode, and verification surfaces.",
    url: "https://www.braavolabs.com/features",
  },
};

const CAPABILITIES = [
  {
    label: "Run",
    title: "Cross-vendor workbench",
    copy: "Coordinate model and agent work without turning one vendor runtime into the control plane.",
  },
  {
    label: "Control",
    title: "Exact-action approval",
    copy: "Bind an approval to the action, scope, expiry, and execution context that was actually reviewed.",
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
  return (
    <div className="min-h-screen bv-mesh" data-public-surface="features">
      <nav className="border-b border-outline-variant bg-surface/80 backdrop-blur-xl">
        <div className="max-w-[1080px] mx-auto px-6 h-16 flex items-center justify-between gap-5">
          <a href="/" className="font-headline font-bold no-underline">Braavolabs</a>
          <div className="flex items-center gap-3">
            <a href="/pricing" className="hidden sm:inline text-sm text-on-surface-variant no-underline">Pricing</a>
            <a href="https://app.braavolabs.com/login" className="bv-btn bv-btn-ghost bv-btn-sm no-underline">Sign in</a>
            <a href="https://app.braavolabs.com/register" className="bv-btn bv-btn-primary bv-btn-sm no-underline">Sign up</a>
          </div>
        </div>
      </nav>

      <main className="max-w-[1080px] mx-auto px-6 py-20">
        <header className="max-w-[760px]">
          <p className="bv-pill bv-pill-cyan inline-flex mb-5">Product contract</p>
          <h1 className="font-headline font-bold uppercase text-[clamp(40px,7vw,76px)] leading-[0.95]">Run. Control. Prove.</h1>
          <p className="text-on-surface-variant text-lg mt-6 leading-relaxed">
            Braavolabs is a cross-vendor AI workbench and control plane. The same contract spans desktop, CLI,
            mobile approval, and authenticated cloud control without moving native execution into the public site.
          </p>
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
            <p className="bv-micro text-primary mb-3">Private Mode</p>
            <p className="text-on-surface-variant leading-relaxed">
              Private Mode keeps prompt, output, and artifact content end-to-end encrypted so Braavolabs cloud cannot read the plaintext.
            </p>
          </article>
          <article className="bv-glass p-7">
            <p className="bv-micro text-primary mb-3">Cloud Agent Mode</p>
            <p className="text-on-surface-variant leading-relaxed">
              Cloud Agent Mode processes the content needed to run the task in Braavolabs execution infrastructure with explicit consent and visible retention.
            </p>
          </article>
        </section>

        <section className="bv-glass p-7 mt-5 grid md:grid-cols-2 gap-8">
          <div>
            <h2 className="font-headline font-semibold text-xl">Signed evidence — in development</h2>
            <p className="text-on-surface-variant mt-2">Offline-verifiable bundle claims remain closed until their task is accepted.</p>
          </div>
          <div>
            <h2 className="font-headline font-semibold text-xl">Holding — premium/private preview</h2>
            <p className="text-on-surface-variant mt-2">Persistent-agent packaging remains separate and default-off.</p>
          </div>
        </section>

        <div className="flex flex-wrap gap-3 mt-10">
          <a href="https://app.braavolabs.com/dashboard" className="bv-btn bv-btn-primary no-underline">Launch app</a>
          <a href="/docs" className="bv-btn bv-btn-ghost no-underline">Read docs</a>
        </div>
      </main>
    </div>
  );
}

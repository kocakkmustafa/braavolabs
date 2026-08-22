import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing — Braavolabs",
  description: "Braavolabs Individual and Team subscription pricing. Model inference is supplied by the customer.",
  alternates: { canonical: "https://www.braavolabs.com/pricing" },
  openGraph: {
    title: "Pricing — Braavolabs",
      description: "Individual at $19/month and Team at $39/active-user/month. Inference is supplied by the customer.",
    url: "https://www.braavolabs.com/pricing",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Pricing — Braavolabs",
    description: "Individual at $19/month and Team at $39/active-user/month. Inference is supplied by the customer.",
    images: ["/og-image.png"],
  },
};

const PLANS = [
  {
    name: "Individual",
    price: "$19/month",
    audience: "One person operating governed AI work across supported surfaces.",
    items: ["One user", "BYOK or local model routing", "Private Mode and Cloud Agent Mode", "Paired approval scope"],
  },
  {
    name: "Team",
    price: "$39/active-user/month",
    audience: "Active seats sharing workspace policy, approvals, and operational context.",
    items: ["Active-seat billing", "Shared workspace roles", "Shared policy and approvals", "Team operating context"],
  },
] as const;

export default function PricingPage() {
  return (
    <div className="min-h-screen bv-mesh" data-public-surface="pricing">
      <nav className="border-b border-outline-variant bg-surface/80 backdrop-blur-xl">
        <div className="max-w-[1080px] mx-auto px-6 h-16 flex items-center justify-between gap-5">
          <a href="/" className="font-headline font-bold no-underline">Braavolabs</a>
          <div className="flex items-center gap-3">
            <a href="/features" className="hidden sm:inline text-sm text-on-surface-variant no-underline">Features</a>
            <a href="https://app.braavolabs.com/login" className="bv-btn bv-btn-ghost bv-btn-sm no-underline">Sign in</a>
            <a href="https://app.braavolabs.com/register" className="bv-btn bv-btn-primary bv-btn-sm no-underline">Sign up</a>
          </div>
        </div>
      </nav>

      <main className="max-w-[1080px] mx-auto px-6 py-20">
        <header className="text-center max-w-[720px] mx-auto">
          <p className="bv-pill bv-pill-cyan inline-flex mb-5">Public pricing contract</p>
          <h1 className="font-headline font-bold uppercase text-[clamp(40px,7vw,72px)] leading-none">Two plans. Clear inputs.</h1>
          <p className="text-on-surface-variant text-lg mt-6">
            Inference is not included. Use your own provider keys (BYOK) or local models.
          </p>
        </header>

        <section className="grid md:grid-cols-2 gap-6 mt-14">
          {PLANS.map((plan) => (
            <article key={plan.name} className="bv-glass p-8 flex flex-col">
              <p className="bv-micro text-primary mb-3">Subscription</p>
              <h2 className="font-headline font-semibold text-3xl">{plan.name} — {plan.price}</h2>
              <p className="text-on-surface-variant mt-4 leading-relaxed">{plan.audience}</p>
              <ul className="mt-7 flex-1 space-y-3 text-on-surface-variant">
                {plan.items.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span aria-hidden className="text-primary">✓</span>{item}
                  </li>
                ))}
              </ul>
              <a href="https://app.braavolabs.com/register" className="bv-btn bv-btn-primary justify-center no-underline mt-8">Choose {plan.name}</a>
            </article>
          ))}
        </section>

        <section className="bv-glass p-8 mt-6 grid md:grid-cols-2 gap-8">
          <div>
            <p className="bv-micro text-primary mb-3">Data modes</p>
            <p className="text-on-surface-variant leading-relaxed">
              Private Mode keeps prompt, output, and artifact content end-to-end encrypted so Braavolabs cloud cannot read the plaintext.
            </p>
          </div>
          <div>
            <p className="bv-micro text-primary mb-3">Data modes</p>
            <p className="text-on-surface-variant leading-relaxed">
              Cloud Agent Mode processes the content needed to run the task in Braavolabs execution infrastructure with explicit consent and visible retention.
            </p>
          </div>
        </section>

        <section className="text-center mt-12">
          <p className="font-headline font-semibold text-xl">Holding — premium/private preview</p>
          <p className="text-on-surface-variant mt-2">Holding is not bundled into either public subscription.</p>
          <a href="https://app.braavolabs.com/dashboard" className="bv-btn bv-btn-ghost no-underline mt-6">Launch app</a>
        </section>
      </main>
    </div>
  );
}

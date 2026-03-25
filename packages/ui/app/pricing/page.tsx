"use client";

const PLANS = [
  {
    name: "Free",
    price: "$0",
    period: "forever",
    desc: "Try the full platform with real AI outputs.",
    features: [
      "1 AI company",
      "10 runs / month",
      "TikTok + LinkedIn channels",
      "Full audit log",
      "AI agent stack",
      "Community support",
    ],
    cta: "Start Free",
    highlight: false,
    badge: null,
  },
  {
    name: "Pro",
    price: "$49",
    period: "/ month",
    desc: "For founders running multiple AI companies.",
    features: [
      "5 AI companies",
      "Unlimited runs",
      "All channels",
      "HubSpot CRM sync",
      "Advanced analytics",
      "Priority support",
    ],
    cta: "Get Pro",
    highlight: true,
    badge: "Most Popular",
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    desc: "Unlimited scale with SLA and dedicated support.",
    features: [
      "Unlimited companies",
      "Unlimited runs",
      "Custom integrations",
      "SSO & SAML",
      "SLA guarantee",
      "Dedicated support",
    ],
    cta: "Contact Us",
    highlight: false,
    badge: null,
  },
];

export default function PricingPage() {
  return (
    <div className="min-h-screen" style={{ background: "#10131a" }}>
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 md:px-10 py-5 max-w-[1100px] mx-auto"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
        <a href="/" className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}>
            <span className="text-white font-bold text-xs">AI</span>
          </div>
          <span className="font-headline font-bold text-sm" style={{ color: "#e1e2eb" }}>AI Company OS</span>
        </a>
        <div className="flex items-center gap-4 text-sm" style={{ color: "#859399" }}>
          <a href="/features" className="hover:text-white transition-colors">Features</a>
          <a href="/login" className="px-4 py-2 rounded-xl font-semibold text-white text-xs transition-all hover:brightness-110"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}>
            Get Started
          </a>
        </div>
      </nav>

      <div className="max-w-[900px] mx-auto px-6 py-16">
        <div className="text-center mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full mb-5"
            style={{ border: "1px solid rgba(0,209,255,0.25)", background: "rgba(0,209,255,0.06)" }}>
            <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "#00d1ff" }} />
            <span className="text-xs font-semibold tracking-widest" style={{ color: "#00d1ff" }}>FREE TO START</span>
          </div>
          <h1 className="font-headline font-extrabold mb-3"
            style={{ fontSize: "clamp(2rem, 4vw, 3rem)", color: "#e1e2eb", lineHeight: 1.1 }}>
            Simple, transparent pricing
          </h1>
          <p style={{ color: "#859399", maxWidth: 420, margin: "0 auto" }}>
            No credit card required. Real AI outputs on the free plan, forever.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {PLANS.map((plan) => (
            <div key={plan.name} className="relative flex flex-col p-6 rounded-2xl"
              style={{
                background: plan.highlight ? "rgba(0,209,255,0.05)" : "rgba(29,32,38,0.7)",
                border: plan.highlight ? "1.5px solid rgba(0,209,255,0.3)" : "1px solid rgba(255,255,255,0.05)",
                boxShadow: plan.highlight ? "0 0 40px rgba(0,209,255,0.07)" : "none",
              }}>
              {plan.badge && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full text-xs font-bold text-white"
                  style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}>
                  {plan.badge}
                </span>
              )}
              <div className="mb-5">
                <p className="font-headline font-semibold mb-1 text-sm" style={{ color: "#e1e2eb" }}>{plan.name}</p>
                <div className="flex items-baseline gap-1 mb-2">
                  <span className="font-headline font-black text-3xl"
                    style={{ color: plan.highlight ? "#00d1ff" : "#e1e2eb" }}>{plan.price}</span>
                  <span className="text-xs" style={{ color: "#859399" }}>{plan.period}</span>
                </div>
                <p className="text-xs" style={{ color: "#859399" }}>{plan.desc}</p>
              </div>

              <ul className="space-y-2.5 mb-7 flex-1">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-center gap-2 text-xs" style={{ color: "#bbc9cf" }}>
                    <span className="material-symbols-outlined text-sm" style={{ color: plan.highlight ? "#00d1ff" : "#3c494e" }}>
                      check
                    </span>
                    {f}
                  </li>
                ))}
              </ul>

              <a href="/login"
                className="block text-center py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                style={{
                  background: plan.highlight ? "linear-gradient(135deg, #00d1ff, #6d11ad)" : "rgba(255,255,255,0.06)",
                  color: plan.highlight ? "white" : "#bbc9cf",
                  border: plan.highlight ? "none" : "1px solid rgba(255,255,255,0.08)",
                }}>
                {plan.cta}
              </a>
            </div>
          ))}
        </div>

        {/* FAQ strip */}
        <div className="mt-14 grid grid-cols-1 md:grid-cols-2 gap-4">
          {[
            { q: "Do I need a credit card?", a: "No. The free plan is completely free forever — no card required." },
            { q: "What counts as a 'run'?", a: "Each pipeline execution is one run. A run can have multiple steps and tool calls." },
            { q: "Can I cancel anytime?", a: "Yes. Cancel your subscription at any time with no penalty or lock-in." },
            { q: "Is my data private?", a: "Yes. Each tenant is fully isolated. We never share or train on your company data." },
          ].map((item) => (
            <div key={item.q} className="p-5 rounded-xl"
              style={{ background: "rgba(29,32,38,0.5)", border: "1px solid rgba(255,255,255,0.05)" }}>
              <p className="font-semibold text-sm mb-1.5" style={{ color: "#e1e2eb" }}>{item.q}</p>
              <p className="text-xs leading-relaxed" style={{ color: "#859399" }}>{item.a}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

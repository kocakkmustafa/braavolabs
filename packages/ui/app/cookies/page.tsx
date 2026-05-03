"use client";

export default function CookiesPage() {
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
        <a href="/" className="text-sm hover:text-white transition-colors" style={{ color: "#859399" }}>← Back</a>
      </nav>

      <div className="max-w-[720px] mx-auto px-6 py-16">
        <div className="mb-10">
          <h1 className="font-headline font-extrabold mb-2" style={{ fontSize: "2rem", color: "#e1e2eb" }}>Cookie Policy</h1>
          <p className="text-sm" style={{ color: "#3c494e" }}>Last updated: May 2026</p>
        </div>

        <div className="space-y-8 text-sm leading-relaxed" style={{ color: "#859399" }}>
          {[
            { title: "What Cookies Are", body: "Cookies are small text files placed on your device when you visit a website. We use cookies and similar local storage techniques to keep you signed in, remember your language preference, and improve your experience." },
            { title: "Cookies We Use", body: "Strictly necessary: a JWT session token for authentication. Preference: NEXT_LOCALE to remember your language. We do not run ad-targeting cookies. Analytics is opt-in (Plausible, cookie-less by default)." },
            { title: "Third-Party Cookies", body: "Stripe Checkout sets cookies during payment flows for fraud prevention. HubSpot tracking pixels run only if you opt in. Google or GitHub OAuth set their own cookies during sign-in — those are governed by their respective policies." },
            { title: "How to Manage Cookies", body: "Most browsers allow you to refuse or delete cookies through their settings. Disabling strictly necessary cookies will prevent you from signing in. Where required, our cookie banner lets you accept or reject non-essential cookies." },
            { title: "Legal Basis", body: "We rely on legitimate interest for strictly necessary cookies (KVKK Art. 5/2-f and GDPR Art. 6(1)(f)) and on your consent for non-essential cookies (KVKK Art. 5/1 and GDPR Art. 6(1)(a))." },
            { title: "Contact", body: "Questions about cookies? Email privacy@braavolabs.com." },
          ].map((section) => (
            <div key={section.title}>
              <h2 className="font-headline font-semibold text-sm mb-2" style={{ color: "#e1e2eb" }}>{section.title}</h2>
              <p>{section.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

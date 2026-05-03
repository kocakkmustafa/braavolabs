"use client";

export default function ContactPage() {
  const channels = [
    { label: "General questions", email: "hello@braavolabs.com" },
    { label: "Customer support", email: "support@braavolabs.com" },
    { label: "Sales / partnerships", email: "sales@braavolabs.com" },
    { label: "Privacy & GDPR", email: "privacy@braavolabs.com" },
    { label: "KVKK (Türkiye)", email: "kvkk@braavolabs.com" },
    { label: "Security disclosures", email: "security@braavolabs.com" },
  ];

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
          <h1 className="font-headline font-extrabold mb-2" style={{ fontSize: "2rem", color: "#e1e2eb" }}>Contact</h1>
          <p className="text-sm" style={{ color: "#3c494e" }}>Pick the channel that fits — we read everything.</p>
        </div>

        <div className="space-y-3 text-sm">
          {channels.map((c) => (
            <div
              key={c.email}
              className="flex items-center justify-between px-4 py-3 rounded-xl"
              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}
            >
              <span style={{ color: "#bbc9cf" }}>{c.label}</span>
              <a href={`mailto:${c.email}`} className="transition-colors hover:opacity-80" style={{ color: "#a4e6ff" }}>
                {c.email}
              </a>
            </div>
          ))}
        </div>

        <p className="mt-10 text-xs" style={{ color: "#3c494e" }}>
          Response time: typically within 24 hours on weekdays. KVKK and GDPR rights requests are answered within their statutory windows (30 days and 1 month respectively).
        </p>
      </div>
    </div>
  );
}

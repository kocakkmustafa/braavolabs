"use client";

export default function StatusPage() {
  const services = [
    "Public website",
    "Authentication",
    "API",
    "Pipeline runs",
    "Database",
    "Email delivery",
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
        <div className="mb-3 flex items-center gap-3">
          <span
            className="w-3 h-3 rounded-full"
            style={{ background: "#34d399", boxShadow: "0 0 12px #34d39988" }}
          />
          <h1 className="font-headline font-extrabold" style={{ fontSize: "2rem", color: "#e1e2eb" }}>All systems operational</h1>
        </div>
        <p className="text-sm mb-10" style={{ color: "#3c494e" }}>
          Manually verified status. A real-time public status page (separate subdomain) is on the roadmap.
        </p>

        <div className="space-y-2 mb-10">
          {services.map((name) => (
            <div
              key={name}
              className="flex items-center justify-between px-4 py-3 rounded-xl"
              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}
            >
              <span className="text-sm" style={{ color: "#bbc9cf" }}>{name}</span>
              <span className="flex items-center gap-2 text-xs" style={{ color: "#34d399" }}>
                <span className="w-2 h-2 rounded-full" style={{ background: "#34d399" }} />
                Operational
              </span>
            </div>
          ))}
        </div>

        <div
          className="p-5 rounded-xl text-sm"
          style={{ background: "rgba(0,209,255,0.04)", border: "1px solid rgba(0,209,255,0.15)", color: "#bbc9cf" }}
        >
          <strong style={{ color: "#e1e2eb" }}>Spotted an outage?</strong> Email{" "}
          <a href="mailto:support@braavolabs.com" style={{ color: "#a4e6ff" }}>support@braavolabs.com</a>{" "}
          with what you tried and the error you saw — we&apos;ll investigate and update this page.
        </div>
      </div>
    </div>
  );
}

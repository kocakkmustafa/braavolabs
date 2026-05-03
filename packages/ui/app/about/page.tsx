"use client";

export default function AboutPage() {
  const sections = [
    {
      title: "Why we exist",
      body: "Most founders need an agency, an SDR, a content team, an ops manager — but can't afford five hires. Braavolabs replaces that team with AI agents that run pipelines you describe in plain English. Spend approval, audit logs, and risk stops are built in so you stay in control.",
    },
    {
      title: "What we're building",
      body: "A platform where you describe a company in natural language — sales, content, ops — and our AI builder writes the agents, pipelines, and integrations from scratch. Every action is logged, every dollar of spend goes through approval, and the whole thing runs 24/7.",
    },
    {
      title: "Who's behind it",
      body: "Braavolabs is an independent project founded in 2026. We build in public — every commit, every decision, every roadmap update is visible. Reach out anytime: hello@braavolabs.com.",
    },
    {
      title: "What's next",
      body: "Our roadmap is shaped by what users actually run into — not by a 12-month plan written in a vacuum. Want to influence what we build? Try the free tier, give us feedback at hello@braavolabs.com, or follow build-in-public updates on social.",
    },
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
          <h1 className="font-headline font-extrabold mb-2" style={{ fontSize: "2rem", color: "#e1e2eb" }}>About Braavolabs</h1>
          <p className="text-sm" style={{ color: "#3c494e" }}>Building autonomous AI companies — without the agency overhead.</p>
        </div>

        <div className="space-y-8 text-sm leading-relaxed" style={{ color: "#859399" }}>
          {sections.map((section) => (
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

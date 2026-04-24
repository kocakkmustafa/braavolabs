"use client";

export default function DocsPage() {
  const sections = [
    {
      title: "Getting Started",
      items: [
        { label: "What is Braavolabs?", desc: "An autonomous company creation platform powered by Claude. Describe your business in plain text — AI builds and runs everything." },
        { label: "Creating your first company", desc: "From the sidebar, click the gradient + button (\"New Company\") or open the Onboarding wizard. Type a description of your business idea. AI will ask up to 3 clarification questions, then generate agents and pipelines." },
        { label: "Understanding primitives", desc: "Every company is built from 9 building blocks: Acquisition, Sales, Delivery, Content, Operations, Finance, Analytics, Memory, Governance." },
      ],
    },
    {
      title: "Agents & Pipelines",
      items: [
        { label: "How agents work", desc: "Agents are Claude-powered workers with specific roles, tools, and budgets. Each agent logs every decision with a reasoning field." },
        { label: "Running a pipeline", desc: "Pipelines are multi-step workflows that trigger agents in sequence. They can run on a schedule (cron) or be triggered manually." },
        { label: "Approval gates", desc: "Only spend-requiring actions need your approval. Everything else runs autonomously. Check the Approvals page for pending items." },
      ],
    },
    {
      title: "Memory & Learning",
      items: [
        { label: "Memory lifecycle", desc: "Memories start as 'candidate', require validation before becoming 'approved', and can be 'deprecated' when outdated." },
        { label: "Holding brain", desc: "Patterns that appear across 2+ companies can be promoted to the holding brain — shared intelligence across all your companies." },
      ],
    },
    {
      title: "Governance & Risk",
      items: [
        { label: "Risk stops", desc: "Built-in circuit breakers: cost anomaly (>20% budget), loop detection (5+ failed retries), spam stop (3+ unanswered contacts), brand violations." },
        { label: "Audit log", desc: "Every action, tool call, and decision is permanently logged with actor, timestamp, reasoning, and cost." },
      ],
    },
  ];

  return (
    <div className="min-h-screen" style={{ background: "#0a0d14" }}>
      <nav className="flex items-center justify-between px-6 md:px-10 py-5 max-w-[1100px] mx-auto"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
        <a href="/" className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}>
            <span className="text-white font-bold text-xs">AI</span>
          </div>
          <span className="font-headline font-bold text-sm" style={{ color: "#e1e2eb" }}>Braavolabs</span>
        </a>
        <div className="flex items-center gap-4 text-sm" style={{ color: "#859399" }}>
          <a href="/features" className="hover:text-white transition-colors">Features</a>
          <a href="/pricing" className="hover:text-white transition-colors">Pricing</a>
          <a href="/login" className="px-4 py-2 rounded-xl font-semibold text-white text-xs"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}>
            Get Started
          </a>
        </div>
      </nav>

      <div className="max-w-[780px] mx-auto px-6 py-16">
        <div className="mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full mb-5"
            style={{ border: "1px solid rgba(0,209,255,0.25)", background: "rgba(0,209,255,0.06)" }}>
            <span className="text-xs font-semibold tracking-widest" style={{ color: "#00d1ff" }}>DOCUMENTATION</span>
          </div>
          <h1 className="font-headline font-extrabold mb-3"
            style={{ fontSize: "clamp(1.8rem, 4vw, 2.5rem)", color: "#e1e2eb", lineHeight: 1.1 }}>
            Platform Documentation
          </h1>
          <p style={{ color: "#859399" }}>Everything you need to build and run autonomous AI companies.</p>
        </div>

        <div className="space-y-10">
          {sections.map((section) => (
            <div key={section.title}>
              <h2 className="font-headline font-bold text-base mb-4"
                style={{ color: "#00d1ff", borderBottom: "1px solid rgba(0,209,255,0.1)", paddingBottom: "0.5rem" }}>
                {section.title}
              </h2>
              <div className="space-y-3">
                {section.items.map((item) => (
                  <div key={item.label} className="p-4 rounded-xl"
                    style={{ background: "rgba(29,32,38,0.6)", border: "1px solid rgba(255,255,255,0.05)" }}>
                    <p className="font-semibold text-sm mb-1" style={{ color: "#e1e2eb" }}>{item.label}</p>
                    <p className="text-xs leading-relaxed" style={{ color: "#859399" }}>{item.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-12 p-6 rounded-2xl text-center"
          style={{ background: "rgba(0,209,255,0.05)", border: "1px solid rgba(0,209,255,0.15)" }}>
          <p className="font-semibold mb-2" style={{ color: "#e1e2eb" }}>Ready to build?</p>
          <p className="text-sm mb-4" style={{ color: "#859399" }}>Create your first AI company in 10 minutes.</p>
          <a href="/login"
            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold text-white"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}>
            Start Free
          </a>
        </div>
      </div>
    </div>
  );
}

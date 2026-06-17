import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "How Braavolabs compares",
  description:
    "How Braavolabs compares to Zapier, Make, n8n, Lindy, and Gumloop — mid-run steering, mobile control, flat pricing, governance, and where each tool wins.",
  alternates: { canonical: "https://braavolabs.com/compare" },
  openGraph: {
    title: "How Braavolabs compares — Braavolabs",
    description:
      "Where Braavolabs is strong (mobile control, mid-run steering, flat price, offline) and where workflow tools and agent builders win. Qualitative, defensible claims only.",
    url: "https://braavolabs.com/compare",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

// ── Comparison matrix ──────────────────────────────────────────────
// Cells are qualitative on purpose: ✓ (strong / first-class), "~" (partial /
// possible-with-effort), "—" (not a focus). No fabricated stats — every claim
// below is a defensible positioning statement, not a benchmark.
type Cell = "yes" | "partial" | "no";

interface Row {
  label: string;
  note: string;
  braavolabs: Cell;
  workflow: Cell;
  agents: Cell;
}

const COLS = [
  { key: "braavolabs", name: "Braavolabs", highlight: true },
  { key: "workflow", name: "Workflow automation", sub: "Zapier · Make · n8n", highlight: false },
  { key: "agents", name: "AI agent builders", sub: "Lindy · Gumloop · Relevance", highlight: false },
] as const;

const ROWS: Row[] = [
  {
    label: "Mid-run steering",
    note: "Redirect a run in flight without restarting it",
    braavolabs: "yes",
    workflow: "no",
    agents: "partial",
  },
  {
    label: "Native mobile control",
    note: "A real iOS / Android app, not a responsive dashboard",
    braavolabs: "yes",
    workflow: "partial",
    agents: "no",
  },
  {
    label: "Approve spend from your phone",
    note: "Money-touching steps wait for a tap before they run",
    braavolabs: "yes",
    workflow: "no",
    agents: "partial",
  },
  {
    label: "BYOK provider breadth",
    note: "Bring your own keys across many model vendors",
    braavolabs: "yes",
    workflow: "partial",
    agents: "partial",
  },
  {
    label: "On-device / offline",
    note: "Run sensitive work locally with on-device models",
    braavolabs: "yes",
    workflow: "no",
    agents: "no",
  },
  {
    label: "External-automation monitoring",
    note: "Watch the n8n / Make / Zapier flows you already run",
    braavolabs: "yes",
    workflow: "partial",
    agents: "no",
  },
  {
    label: "Pricing model",
    note: "How the bill grows as you do more",
    braavolabs: "yes", // flat
    workflow: "no", // per-task metering
    agents: "no", // credits / per-run
  },
  {
    label: "Governance & risk-stops",
    note: "Built-in guards that halt runaway behaviour",
    braavolabs: "yes",
    workflow: "partial",
    agents: "partial",
  },
  {
    label: "Audit trail",
    note: "Every tool call logged, every step reasoned",
    braavolabs: "yes",
    workflow: "partial",
    agents: "partial",
  },
  {
    label: "Connector count",
    note: "Sheer number of pre-built app integrations",
    braavolabs: "partial",
    workflow: "yes",
    agents: "partial",
  },
];

// Pricing row gets word labels instead of a glyph, since the distinction is
// the model itself rather than presence/absence of a feature.
const PRICING_LABELS: Record<string, string> = {
  braavolabs: "Flat",
  workflow: "Per-task",
  agents: "Credits",
};

function CellGlyph({ value, highlight }: { value: Cell; highlight: boolean }) {
  if (value === "yes") {
    return (
      <span
        className="material-symbols-outlined"
        style={{ color: highlight ? "#60A5FA" : "#3B82F6", fontSize: 20 }}
        aria-label="First-class"
      >
        check_circle
      </span>
    );
  }
  if (value === "partial") {
    return (
      <span
        style={{ color: "#FF7A1A", fontFamily: "var(--bv-font-mono)", fontSize: 13, letterSpacing: "0.02em" }}
        aria-label="Partial"
      >
        partial
      </span>
    );
  }
  return (
    <span style={{ color: "var(--color-outline)" }} aria-label="Not a focus">
      —
    </span>
  );
}

const AUDIENCE = [
  {
    icon: "smartphone",
    title: "Operators who aren't at a desk",
    body: "If approvals, nudges, and course-corrections happen from your phone between meetings, the native app and pocket-steering are the whole point.",
  },
  {
    icon: "tune",
    title: "People who hate re-running things",
    body: "Long pipelines that you'd rather steer than restart. Lean over the run's shoulder, redirect it mid-flight, and keep the good steps it already did.",
  },
  {
    icon: "shield_lock",
    title: "Privacy-sensitive work",
    body: "Bring your own keys, keep your data, and run the sensitive parts on-device or fully offline with a machine-bound encrypted bundle.",
  },
  {
    icon: "hub",
    title: "Teams already living in n8n / Make / Zapier",
    body: "Keep the flows you've built. Braavolabs sits on top to monitor, govern, and steer them — it doesn't ask you to migrate.",
  },
];

export default function ComparePage() {
  return (
    <div className="min-h-screen bv-mesh">
      {/* ── Nav ── */}
      <nav
        className="sticky top-0 z-30 flex items-center justify-between px-6 md:px-10 py-4"
        style={{
          background: "rgba(6,7,10,0.72)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderBottom: "1px solid rgba(255,255,255,0.05)",
        }}
      >
        <a href="/" className="flex items-center gap-2.5 no-underline">
          <div
            className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: "var(--bv-gradient-brand)" }}
          >
            <span className="material-symbols-outlined text-white" style={{ fontSize: "16px" }}>
              bolt
            </span>
          </div>
          <span className="font-headline font-bold text-sm" style={{ color: "var(--color-on-surface)" }}>
            Braavolabs
          </span>
        </a>

        <div className="hidden md:flex items-center gap-6">
          {(["Features", "Pricing", "Integrations", "Blog"] as const).map((label) => (
            <a
              key={label}
              href={label === "Blog" ? "/blog" : `/${label.toLowerCase()}`}
              className="text-sm transition-colors hover:text-white no-underline"
              style={{ color: "var(--color-on-surface-variant)" }}
            >
              {label}
            </a>
          ))}
          <a href="/compare" className="text-sm font-semibold no-underline" style={{ color: "var(--color-primary)" }}>
            Compare
          </a>
        </div>

        <div className="flex items-center gap-2">
          <a href="/login" className="bv-btn bv-btn-sm bv-btn-ghost no-underline">
            Sign in
          </a>
          <a href="/register" className="bv-btn bv-btn-sm bv-btn-primary no-underline">
            Start free
          </a>
        </div>
      </nav>

      <main>
        {/* ── Page head ── */}
        <header className="max-w-5xl mx-auto px-6 md:px-10 pt-16 pb-10">
          <div className="bv-micro mb-3" style={{ color: "var(--color-primary)" }}>
            Honest positioning
          </div>
          <h1
            className="font-headline font-bold mb-4"
            style={{
              fontSize: "clamp(36px, 6vw, 64px)",
              lineHeight: 0.95,
              letterSpacing: "-0.02em",
              textTransform: "uppercase",
              color: "var(--color-on-surface)",
            }}
          >
            Where we fit —<br />and where we don&apos;t.
          </h1>
          <p
            className="leading-relaxed"
            style={{ color: "var(--color-on-surface-variant)", maxWidth: "60ch", fontSize: "17px" }}
          >
            Braavolabs isn&apos;t trying to be the biggest integration catalog. It&apos;s built to{" "}
            <span style={{ color: "var(--color-on-surface)" }}>command</span> the agents and automations you
            already run — from your phone, mid-run, on your own keys. Here&apos;s an honest read on how that
            compares to two neighbouring categories, including where they beat us.
          </p>
        </header>

        {/* ── Comparison table ── */}
        <section className="px-6 md:px-10 pb-6">
          <div className="max-w-5xl mx-auto">
            <div className="bv-glass" style={{ overflow: "hidden", padding: 0 }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14.5, minWidth: 720 }}>
                  <thead>
                    <tr>
                      <th
                        style={{
                          padding: "18px 22px",
                          textAlign: "left",
                          borderBottom: "1px solid var(--bv-glass-border)",
                          fontFamily: "var(--bv-font-mono)",
                          fontSize: 11,
                          letterSpacing: "0.14em",
                          color: "var(--color-outline)",
                          fontWeight: 500,
                          textTransform: "uppercase",
                          minWidth: 240,
                        }}
                      >
                        Capability
                      </th>
                      {COLS.map((col) => (
                        <th
                          key={col.key}
                          style={{
                            padding: "18px 18px",
                            textAlign: "center",
                            borderBottom: "1px solid var(--bv-glass-border)",
                            background: col.highlight ? "rgba(59,130,246,0.05)" : undefined,
                            verticalAlign: "bottom",
                          }}
                        >
                          <div
                            className="font-headline font-semibold"
                            style={{
                              fontSize: 16,
                              textTransform: "uppercase",
                              color: col.highlight ? "#60A5FA" : "var(--color-on-surface)",
                              letterSpacing: "-0.02em",
                            }}
                          >
                            {col.name}
                          </div>
                          {"sub" in col && col.sub ? (
                            <div
                              className="bv-mono"
                              style={{ fontSize: 10.5, color: "var(--color-outline)", marginTop: 4, letterSpacing: "0.02em" }}
                            >
                              {col.sub}
                            </div>
                          ) : (
                            <div className="bv-mono" style={{ fontSize: 10.5, color: "transparent", marginTop: 4 }}>
                              .
                            </div>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ROWS.map((row, i) => {
                      const isPricing = row.label === "Pricing model";
                      const last = i === ROWS.length - 1;
                      return (
                        <tr key={row.label}>
                          <td
                            style={{
                              padding: "16px 22px",
                              borderBottom: last ? undefined : "1px solid rgba(35,40,51,0.5)",
                            }}
                          >
                            <div style={{ color: "var(--color-on-surface)", fontSize: 14.5, fontWeight: 500 }}>
                              {row.label}
                            </div>
                            <div style={{ color: "var(--color-on-surface-variant)", fontSize: 12.5, marginTop: 2, lineHeight: 1.45 }}>
                              {row.note}
                            </div>
                          </td>
                          {COLS.map((col) => {
                            const value = row[col.key as keyof Row] as Cell;
                            return (
                              <td
                                key={col.key}
                                style={{
                                  padding: "16px 18px",
                                  textAlign: "center",
                                  borderBottom: last ? undefined : "1px solid rgba(35,40,51,0.5)",
                                  background: col.highlight ? "rgba(59,130,246,0.05)" : undefined,
                                }}
                              >
                                {isPricing ? (
                                  <span
                                    style={{
                                      fontFamily: "var(--bv-font-mono)",
                                      fontSize: 12.5,
                                      color:
                                        col.key === "braavolabs"
                                          ? "#60A5FA"
                                          : "var(--color-on-surface-variant)",
                                      fontWeight: col.key === "braavolabs" ? 600 : 400,
                                    }}
                                  >
                                    {PRICING_LABELS[col.key]}
                                  </span>
                                ) : (
                                  <CellGlyph value={value} highlight={col.highlight} />
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Legend + honesty note */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mt-5 px-1">
              <span className="flex items-center gap-1.5" style={{ fontSize: 12.5, color: "var(--color-on-surface-variant)" }}>
                <span className="material-symbols-outlined" style={{ color: "#3B82F6", fontSize: 16 }}>
                  check_circle
                </span>
                First-class
              </span>
              <span className="flex items-center gap-1.5" style={{ fontSize: 12.5, color: "var(--color-on-surface-variant)" }}>
                <span style={{ color: "#FF7A1A", fontFamily: "var(--bv-font-mono)", fontSize: 12 }}>partial</span>
                Possible, but not the focus
              </span>
              <span className="flex items-center gap-1.5" style={{ fontSize: 12.5, color: "var(--color-on-surface-variant)" }}>
                <span style={{ color: "var(--color-outline)" }}>—</span>
                Not a focus
              </span>
            </div>
            <p className="bv-caption mt-3 px-1" style={{ color: "var(--color-outline)", maxWidth: "70ch" }}>
              This table is a qualitative positioning read, not a benchmark. Categories are broad — individual
              products in each column vary, and several are excellent at what they do. We&apos;ve marked the
              connector-count row honestly: the big workflow tools win it, and that&apos;s fine.
            </p>
          </div>
        </section>

        {/* ── The two neighbours, explained ── */}
        <section className="px-6 md:px-10 pt-12">
          <div className="max-w-5xl mx-auto grid gap-5 md:grid-cols-2">
            <div className="bv-glass" style={{ padding: "26px 28px" }}>
              <div className="bv-micro mb-2" style={{ color: "var(--color-outline)" }}>
                vs. Workflow automation
              </div>
              <h3 className="font-headline font-semibold mb-3" style={{ fontSize: 19, color: "var(--color-on-surface)" }}>
                Zapier · Make · n8n
              </h3>
              <p className="bv-body" style={{ color: "var(--color-on-surface-variant)", lineHeight: 1.6 }}>
                These are deterministic plumbing — trigger, step, step, done — with enormous connector
                catalogs. They&apos;re great at moving data between apps. Where they&apos;re a different
                tool: there&apos;s no agent to <em>steer</em> mid-run, and the meter typically ticks on{" "}
                <span style={{ color: "var(--color-on-surface)" }}>every task you run</span>, so the bill grows
                with every step. Braavolabs doesn&apos;t replace them — it sits on top to monitor and govern
                the flows you already built.
              </p>
            </div>

            <div className="bv-glass" style={{ padding: "26px 28px" }}>
              <div className="bv-micro mb-2" style={{ color: "var(--color-outline)" }}>
                vs. AI agent builders
              </div>
              <h3 className="font-headline font-semibold mb-3" style={{ fontSize: 19, color: "var(--color-on-surface)" }}>
                Lindy · Gumloop · Relevance
              </h3>
              <p className="bv-body" style={{ color: "var(--color-on-surface-variant)", lineHeight: 1.6 }}>
                The closest neighbours — they also compose agents from steps. The difference is the operating
                surface: Braavolabs is built phone-first, with mid-run steering, approve-from-phone spend
                gates, BYOK across many providers, an on-device offline path, and five built-in risk-stops.
                Most builders are web-first and priced on credits or per-run, which can be hard to predict.
              </p>
            </div>
          </div>
        </section>

        {/* ── Who it's for ── */}
        <section className="px-6 md:px-10 pt-16">
          <div className="max-w-5xl mx-auto">
            <h2
              className="font-headline font-semibold mb-2"
              style={{ fontSize: "clamp(24px, 4vw, 34px)", color: "var(--color-on-surface)", letterSpacing: "-0.02em", textTransform: "uppercase" }}
            >
              Who it&apos;s for
            </h2>
            <p className="bv-body mb-8" style={{ color: "var(--color-on-surface-variant)", maxWidth: "56ch" }}>
              Braavolabs is the right call when control, mobility, and privacy matter more than the raw size of
              an integration catalog.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              {AUDIENCE.map((a) => (
                <div key={a.title} className="bv-glass flex gap-4" style={{ padding: "22px 24px" }}>
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center flex-none"
                    style={{ background: "rgba(59,130,246,0.10)", border: "1px solid rgba(59,130,246,0.20)" }}
                  >
                    <span className="material-symbols-outlined" style={{ color: "#60A5FA", fontSize: 20 }}>
                      {a.icon}
                    </span>
                  </div>
                  <div>
                    <h3 className="font-headline font-semibold mb-1" style={{ fontSize: 16, color: "var(--color-on-surface)" }}>
                      {a.title}
                    </h3>
                    <p className="bv-body" style={{ color: "var(--color-on-surface-variant)", lineHeight: 1.55, fontSize: 14 }}>
                      {a.body}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── CTA strip ── */}
        <section className="px-6 md:px-10 pt-16 pb-4">
          <div className="max-w-5xl mx-auto">
            <div
              className="bv-glass flex flex-col sm:flex-row items-center justify-between gap-6"
              style={{ padding: "30px 32px", border: "1px solid rgba(37,99,235,0.25)", background: "rgba(37,99,235,0.04)" }}
            >
              <div>
                <p className="font-headline font-semibold mb-1" style={{ fontSize: 19, color: "var(--color-on-surface)" }}>
                  See the flat-price math for yourself.
                </p>
                <p className="bv-body" style={{ color: "var(--color-on-surface-variant)" }}>
                  Compare predictable flat pricing against per-task metering with our cost calculator.
                </p>
              </div>
              <div className="flex items-center gap-3 flex-none">
                <Link href="/cost-calculator" className="bv-btn bv-btn-ghost whitespace-nowrap no-underline">
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                    calculate
                  </span>
                  Cost calculator
                </Link>
                <a href="/register" className="bv-btn bv-btn-primary bv-sheen whitespace-nowrap no-underline">
                  Start free
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* ── Trust strip ── */}
        <section className="px-6 md:px-10 pt-14 pb-4 text-center">
          <div className="max-w-5xl mx-auto">
            <div className="bv-divider mb-8" />
            <p className="bv-mono" style={{ color: "var(--color-on-surface-variant)", letterSpacing: "0.04em", fontSize: 13 }}>
              Every tool call logged · every spend approved · every run audited
            </p>
          </div>
        </section>
      </main>

      {/* ── Footer ── */}
      <Footer />
    </div>
  );
}

function Footer() {
  return (
    <footer className="border-t" style={{ borderColor: "rgba(58,65,80,0.18)" }}>
      <div className="max-w-5xl mx-auto px-6 md:px-10 py-12">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          <div className="col-span-2 md:col-span-1">
            <a href="/" className="flex items-center gap-2 mb-3 no-underline">
              <div
                className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: "var(--bv-gradient-brand)" }}
              >
                <span className="material-symbols-outlined text-white" style={{ fontSize: "14px" }}>
                  bolt
                </span>
              </div>
              <span className="font-headline font-bold text-sm" style={{ color: "var(--color-on-surface)" }}>
                Braavolabs
              </span>
            </a>
            <p className="text-xs leading-relaxed" style={{ color: "var(--color-on-surface-variant)", maxWidth: "22ch" }}>
              Command the AI agents &amp; automations you already run.
            </p>
          </div>

          <div>
            <h5 className="bv-micro mb-3" style={{ color: "var(--color-outline)" }}>
              Product
            </h5>
            {["Features", "Pricing", "Integrations", "Changelog"].map((link) => (
              <a
                key={link}
                href={`/${link.toLowerCase()}`}
                className="block text-xs mb-2 no-underline hover:text-white transition-colors"
                style={{ color: "var(--color-on-surface-variant)" }}
              >
                {link}
              </a>
            ))}
          </div>

          <div>
            <h5 className="bv-micro mb-3" style={{ color: "var(--color-outline)" }}>
              Company
            </h5>
            {["About", "Blog", "Contact", "Status"].map((link) => (
              <a
                key={link}
                href={link === "Blog" ? "/blog" : `/${link.toLowerCase()}`}
                className="block text-xs mb-2 no-underline hover:text-white transition-colors"
                style={{ color: "var(--color-on-surface-variant)" }}
              >
                {link}
              </a>
            ))}
          </div>

          <div>
            <h5 className="bv-micro mb-3" style={{ color: "var(--color-outline)" }}>
              Legal
            </h5>
            {[
              { label: "Privacy", href: "/privacy" },
              { label: "Terms", href: "/terms" },
              { label: "Security", href: "/security" },
              { label: "GDPR", href: "/gdpr" },
            ].map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="block text-xs mb-2 no-underline hover:text-white transition-colors"
                style={{ color: "var(--color-on-surface-variant)" }}
              >
                {link.label}
              </a>
            ))}
          </div>
        </div>

        <div className="bv-divider my-8" />

        <p className="bv-mono text-center" style={{ color: "var(--color-outline)", fontSize: "11px" }}>
          © 2026 Braavolabs. All rights reserved.
        </p>
      </div>
    </footer>
  );
}

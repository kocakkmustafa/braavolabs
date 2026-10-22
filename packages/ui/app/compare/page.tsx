import { getTranslations as getSeoTranslations } from "next-intl/server";

import { useTranslations as useLegacyTranslations } from "next-intl";
import type { Metadata } from "next";
import Link from "next/link";

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSeoTranslations("seo");
  return {
  title: seo("m8ec104ac0b8d"),
  description:
    seo("maafa6a889064"),
  alternates: { canonical: "https://www.braavolabs.com/compare" },
  openGraph: {
    title: seo("md9141b7cff71"),
    description:
      seo("m5358edf26d92"),
    url: "https://www.braavolabs.com/compare",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};
}

// ── Comparison matrix ──────────────────────────────────────────────
// Cells are qualitative on purpose: ✓ (strong / first-class), "~" (partial /
// possible-with-effort), "—" (not a focus). No fabricated stats — every claim
// below is a defensible positioning statement, not a benchmark.

interface Row {
  label: string;
  note: string;
}

const RAW_COLS = [
  { key: "braavolabs", name: "Braavolabs", highlight: true },
  { key: "workflow", name: "Workflow automation", sub: "Zapier · Make · n8n", highlight: false },
  { key: "agents", name: "AI agent builders", sub: "Lindy · Gumloop · Relevance", highlight: false },
] as const;

const RAW_ROWS: Row[] = [
  {
    label: "Mid-run steering",
    note: "Check when guidance is accepted and applied; an active call may finish first",
  },
  {
    label: "Native mobile control",
    note: "Check supported mobile tasks and release availability for your device",
  },
  {
    label: "Approve spend from your phone",
    note: "Review which actions need approval and which provider calls can already incur cost",
  },
  {
    label: "BYOK provider breadth",
    note: "Bring your own keys across many model vendors",
  },
  {
    label: "Local provider route",
    note: "Use a configured local model endpoint where supported",
  },
  {
    label: "External-automation monitoring",
    note: "Confirm supported monitoring and control actions for each external platform",
  },
  {
    label: "Pricing model",
    note: "Compare subscription, inference, hosting and per-operation charges",
  },
  {
    label: "Governance & risk-stops",
    note: "Review supported check boundaries and incident handling",
  },
  {
    label: "Audit trail",
    note: "Inspect the recorded actions and outputs; missing records remain unknown",
  },
  {
    label: "Connector count",
    note: "Sheer number of pre-built app integrations",
  },
];

const RAW_AUDIENCE = [
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
    body: "Bring your own keys or select a configured local endpoint. Verify the selected route, tools, telemetry, and network boundary separately.",
  },
  {
    icon: "hub",
    title: "Teams already living in n8n / Make / Zapier",
    body: "Use supported connections to monitor status and request supported actions. Check each platform's authorization and execution contract.",
  },
];

export default function ComparePage() {
  const surfaceCopy = useLegacyTranslations("surface");
  const dataCopy = useLegacyTranslations("dataCopy");
  const COLS = RAW_COLS.map((entry, index) => ({ ...entry, name: dataCopy.raw(`comparisonColumns.${index}.name`) as string }));
  const ROWS = RAW_ROWS.map((entry, index) => ({ ...entry, label: dataCopy.raw(`comparisonRows.${index}.label`) as string, note: dataCopy.raw(`comparisonRows.${index}.note`) as string }));
  const AUDIENCE = RAW_AUDIENCE.map((entry, index) => ({ ...entry, title: dataCopy.raw(`comparisonAudience.${index}.title`) as string, body: dataCopy.raw(`comparisonAudience.${index}.body`) as string }));
  const uiText = useLegacyTranslations("uiCopy");
  return (
    <div className="min-h-screen bv-mesh">
      {/* ── Nav ── */}
      <nav
        className="sticky top-0 z-30 flex flex-wrap gap-y-2 items-center justify-between px-6 md:px-10 py-4"
        style={{
          background: "var(--color-surface-container-low)",
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

        <div className="order-last basis-full flex overflow-x-auto whitespace-nowrap pb-1 md:order-none md:basis-auto md:overflow-visible md:pb-0 items-center gap-6">
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
          <a href="/compare" className="text-sm font-semibold no-underline" style={{ color: "var(--color-primary)" }}>{uiText("m1c1ed0d6cba8")}</a>
        </div>

        <div className="flex items-center gap-2">
          <a href="https://app.braavolabs.com/login" className="bv-btn bv-btn-sm bv-btn-ghost no-underline">{uiText("m0e090d020bf6")}</a>
          <a href="https://app.braavolabs.com" className="bv-btn bv-btn-sm bv-btn-primary no-underline">{uiText("m2b2ad5e6e9fc")}</a>
        </div>
      </nav>

      <main>
        {/* ── Page head ── */}
        <header className="max-w-5xl mx-auto px-6 md:px-10 pt-16 pb-10">
          <div className="bv-micro mb-3" style={{ color: "var(--color-primary)" }}>{uiText("m65d72c621640")}</div>
          <h1
            className="font-headline font-bold mb-4"
            style={{
              fontSize: "clamp(36px, 6vw, 64px)",
              lineHeight: 0.95,
              letterSpacing: "-0.02em",
              textTransform: "uppercase",
              color: "var(--color-on-surface)",
            }}
          >{uiText("mba9bd9de37dc")}<br />{uiText("m50e9a7dcec3d")}</h1>
          <p
            className="leading-relaxed"
            style={{ color: "var(--color-on-surface-variant)", maxWidth: "60ch", fontSize: "17px" }}
          >{uiText("mf93fe81f65ba")}{" "}
            <span style={{ color: "var(--color-on-surface)" }}>{uiText("m1d1ed4cc0221")}</span>{" "}{uiText("m16c281eec9eb")}</p>
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
                          textAlign: "start",
                          borderBottom: "1px solid var(--bv-glass-border)",
                          fontFamily: "var(--bv-font-mono)",
                          fontSize: 11,
                          letterSpacing: "0.14em",
                          color: "var(--color-outline)",
                          fontWeight: 500,
                          textTransform: "uppercase",
                          minWidth: 240,
                        }}
                      >{uiText("m7acc6a073df0")}</th>
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
                              color: col.highlight ? "var(--color-primary)" : "var(--color-on-surface)",
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
                                <span className="bv-caption">{surfaceCopy("compare.verify")}</span>
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

            <p role="note" className="bv-caption mt-5">{surfaceCopy("compare.notice")}</p>
          </div>
        </section>

        {/* ── Who it's for ── */}
        <section className="px-6 md:px-10 pt-16">
          <div className="max-w-5xl mx-auto">
            <h2
              className="font-headline font-semibold mb-2"
              style={{ fontSize: "clamp(24px, 4vw, 34px)", color: "var(--color-on-surface)", letterSpacing: "-0.02em", textTransform: "uppercase" }}
            >{uiText("m67969942145e")}</h2>
            <p className="bv-body mb-8" style={{ color: "var(--color-on-surface-variant)", maxWidth: "56ch" }}>{uiText("m8d6c9af2713e")}</p>
            <div className="grid gap-4 md:grid-cols-2">
              {AUDIENCE.map((a) => (
                <div key={a.title} className="bv-glass flex gap-4" style={{ padding: "22px 24px" }}>
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center flex-none"
                    style={{ background: "rgba(59,130,246,0.10)", border: "1px solid rgba(59,130,246,0.20)" }}
                  >
                    <span className="material-symbols-outlined" style={{ color: "var(--color-primary)", fontSize: 20 }}>
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
                <p className="font-headline font-semibold mb-1" style={{ fontSize: 19, color: "var(--color-on-surface)" }}>{uiText("m22f7bc58c61d")}</p>
                <p className="bv-body" style={{ color: "var(--color-on-surface-variant)" }}>{uiText("mbf3573b0a3d0")}</p>
              </div>
              <div className="flex items-center gap-3 flex-none">
                <Link href="/cost-calculator" className="bv-btn bv-btn-ghost whitespace-nowrap no-underline">
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                    calculate
                  </span>{uiText("m24543c9280b1")}</Link>
                <a href="https://app.braavolabs.com" className="bv-btn bv-btn-primary bv-sheen whitespace-nowrap no-underline">{uiText("m2b2ad5e6e9fc")}</a>
              </div>
            </div>
          </div>
        </section>

        {/* ── Trust strip ── */}
        <section className="px-6 md:px-10 pt-14 pb-4 text-center">
          <div className="max-w-5xl mx-auto">
            <div className="bv-divider mb-8" />
            <p className="bv-mono" style={{ color: "var(--color-on-surface-variant)", letterSpacing: "0.04em", fontSize: 13 }}>{uiText("m2b56df60312a")}</p>
          </div>
        </section>
      </main>

      {/* ── Footer ── */}
      <Footer />
    </div>
  );
}

function Footer() {
  const uiText = useLegacyTranslations("uiCopy");
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
            <p className="text-xs leading-relaxed" style={{ color: "var(--color-on-surface-variant)", maxWidth: "22ch" }}>{uiText("m9895a6463bc7")}</p>
          </div>

          <div>
            <h5 className="bv-micro mb-3" style={{ color: "var(--color-outline)" }}>{uiText("mfb1404813b60")}</h5>
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
            <h5 className="bv-micro mb-3" style={{ color: "var(--color-outline)" }}>{uiText("mca345aad7aa1")}</h5>
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
            <h5 className="bv-micro mb-3" style={{ color: "var(--color-outline)" }}>{uiText("m5bed3a4a7338")}</h5>
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

        <p className="bv-mono text-center" style={{ color: "var(--color-outline)", fontSize: "11px" }}>{uiText("m8e359b1c68e3")}</p>
      </div>
    </footer>
  );
}

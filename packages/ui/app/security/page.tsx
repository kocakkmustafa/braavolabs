import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Security & trust",
  description:
    "Braavolabs security: AES-256-GCM at rest, SSRF guards, HMAC webhooks, full audit trail, tenant isolation, BYOK, offline mode, five risk-stops, and GDPR/KVKK compliance.",
  alternates: { canonical: "https://braavolabs.com/security" },
  openGraph: {
    title: "Security & trust — Braavolabs",
    description:
      "Encryption at rest, SSRF guards, signed webhooks, full audit trail, tenant isolation, BYOK, offline mode, five risk-stops, and responsible disclosure.",
    url: "https://braavolabs.com/security",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

interface Pillar {
  icon: string;
  title: string;
  body: string;
  points: string[];
}

const PILLARS: Pillar[] = [
  {
    icon: "lock",
    title: "Encryption at rest",
    body: "Every secret you trust us with — LLM provider keys, integration credentials — is encrypted before it touches the database.",
    points: [
      "AES-256-GCM authenticated encryption for stored secrets",
      "A per-row key derived with scrypt, so one leaked row can't unlock the rest",
      "Plaintext keys are never written to logs, responses, or backups",
    ],
  },
  {
    icon: "key",
    title: "Authentication & sessions",
    body: "Sessions are short-lived and verifiable, and refresh tokens rotate so a stolen token has a narrow blast radius.",
    points: [
      "HS256 JWTs, with the signing secret pinned at verify time",
      "Rotated refresh tokens backed by a Redis allowlist — revoke on logout",
      "Google + GitHub OAuth with CSRF state on every callback",
    ],
  },
  {
    icon: "shield",
    title: "SSRF-guarded outbound",
    body: "Agents reach external services on your behalf, so every outbound destination is resolved and checked before a request is allowed.",
    points: [
      "DNS is resolved and the target IP is validated, not just the hostname",
      "Requests to internal, loopback, and private address ranges are refused",
      "Closes the classic 'point it at an internal URL' SSRF path",
    ],
  },
  {
    icon: "verified_user",
    title: "Signed, replay-safe webhooks",
    body: "External events fan in through a single hardened endpoint that won't accept a forged or stale payload.",
    points: [
      "HMAC-SHA256 signature on every inbound webhook",
      "A required timestamp plus a 5-minute replay window",
      "Stale or unsigned payloads are rejected outright",
    ],
  },
  {
    icon: "fact_check",
    title: "Full audit trail",
    body: "Braavolabs is built so you can reconstruct exactly what happened — these are non-negotiable rules in the codebase, not optional logging.",
    points: [
      "Every tool call is logged",
      "Every step records its reasoning — never empty",
      "Every money-touching action requires an explicit approval row",
      "Every CRUD, send, and decision lands in the activity log",
    ],
  },
  {
    icon: "dns",
    title: "Tenant isolation",
    body: "Your workspace data stays yours. Cross-tenant access is treated as a critical, page-immediately class of bug.",
    points: [
      "Every database query is scoped to a tenant",
      "No primitive reads or writes across tenant boundaries",
      "Cross-tenant access is in scope for our disclosure program",
    ],
  },
  {
    icon: "vpn_key",
    title: "BYOK — your keys, your data",
    body: "Bring your own model and integration keys. You stay in control of where inference runs and which vendors see your prompts.",
    points: [
      "A 14-provider BYOK router (Anthropic, OpenAI, Google, and more)",
      "Free-tier trial traffic is pooled through Groq; paid usage runs on your keys",
      "No lock-in to a single model vendor",
    ],
  },
  {
    icon: "wifi_off",
    title: "On-device & offline option",
    body: "For sensitive work, you don't have to send anything to the cloud at all.",
    points: [
      "Run on-device models locally with an offline path",
      "Pipelines export as machine-bound, encrypted bundles for air-gapped use",
      "A bundle only runs on the machine it was issued for",
    ],
  },
];

const RISK_STOPS = [
  { name: "Hard stop", desc: "An operator kill switch that halts a run immediately." },
  { name: "Loop guard", desc: "Five consecutive failures auto-stops the pipeline." },
  { name: "Cost anomaly", desc: "Any run more than 20% over budget halts mid-execution." },
  { name: "Spam guard", desc: "Three unanswered sends to the same target stops the sequence." },
  { name: "Brand violation", desc: "Output that breaks brand rules is caught before it ships." },
];

export default function SecurityPage() {
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
          <a href="/security" className="text-sm font-semibold no-underline" style={{ color: "var(--color-primary)" }}>
            Security
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
          <div className="inline-flex items-center gap-2 mb-4 bv-pill bv-pill-cyan">
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
              shield_lock
            </span>
            Security &amp; trust
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
            Built to be<br />trusted with keys.
          </h1>
          <p
            className="leading-relaxed"
            style={{ color: "var(--color-on-surface-variant)", maxWidth: "62ch", fontSize: "17px" }}
          >
            Braavolabs runs agents that touch your credentials, your money, and your customers. So the platform
            is designed around a simple idea: encrypt what&apos;s sensitive, log what happens, gate what spends,
            and let you run the most sensitive work entirely on your own machine.
          </p>
        </header>

        {/* ── Pillars grid ── */}
        <section className="px-6 md:px-10 pb-4">
          <div className="max-w-5xl mx-auto grid gap-5 md:grid-cols-2">
            {PILLARS.map((p) => (
              <div key={p.title} className="bv-glass flex flex-col" style={{ padding: "26px 28px" }}>
                <div className="flex items-center gap-3 mb-3">
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center flex-none"
                    style={{ background: "rgba(59,130,246,0.10)", border: "1px solid rgba(59,130,246,0.20)" }}
                  >
                    <span className="material-symbols-outlined" style={{ color: "#60A5FA", fontSize: 20 }}>
                      {p.icon}
                    </span>
                  </div>
                  <h3 className="font-headline font-semibold" style={{ fontSize: 18, color: "var(--color-on-surface)" }}>
                    {p.title}
                  </h3>
                </div>
                <p className="bv-body mb-4" style={{ color: "var(--color-on-surface-variant)", lineHeight: 1.6 }}>
                  {p.body}
                </p>
                <ul className="flex flex-col gap-2.5 mt-auto">
                  {p.points.map((pt) => (
                    <li key={pt} className="flex items-start gap-2.5" style={{ fontSize: 14, color: "var(--color-on-surface-variant)" }}>
                      <span
                        className="material-symbols-outlined flex-none"
                        style={{ fontSize: 16, marginTop: 2, color: "#3B82F6" }}
                      >
                        check_small
                      </span>
                      <span style={{ lineHeight: 1.5 }}>{pt}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* ── Five risk-stops ── */}
        <section className="px-6 md:px-10 pt-16">
          <div className="max-w-5xl mx-auto">
            <div className="bv-micro mb-3" style={{ color: "var(--color-primary)" }}>
              Runaway protection
            </div>
            <h2
              className="font-headline font-semibold mb-2"
              style={{ fontSize: "clamp(24px, 4vw, 34px)", color: "var(--color-on-surface)", letterSpacing: "-0.02em", textTransform: "uppercase" }}
            >
              The five risk-stops
            </h2>
            <p className="bv-body mb-8" style={{ color: "var(--color-on-surface-variant)", maxWidth: "58ch" }}>
              Autonomy is only safe if it can be stopped. Five guards watch every run and halt it the moment
              behaviour looks runaway — before it costs you money or reputation.
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {RISK_STOPS.map((r, i) => (
                <div key={r.name} className="bv-glass" style={{ padding: "20px 22px" }}>
                  <div className="flex items-center gap-2.5 mb-2">
                    <span
                      className="bv-mono"
                      style={{
                        fontSize: 11,
                        color: "#FF7A1A",
                        border: "1px solid rgba(255,122,26,0.35)",
                        borderRadius: 6,
                        padding: "2px 7px",
                        letterSpacing: "0.04em",
                      }}
                    >
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <h3 className="font-headline font-semibold" style={{ fontSize: 16, color: "var(--color-on-surface)" }}>
                      {r.name}
                    </h3>
                  </div>
                  <p className="bv-body" style={{ color: "var(--color-on-surface-variant)", fontSize: 14, lineHeight: 1.55 }}>
                    {r.desc}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Privacy & data rights ── */}
        <section className="px-6 md:px-10 pt-16">
          <div className="max-w-5xl mx-auto">
            <div className="bv-glass" style={{ padding: "30px 32px" }}>
              <div className="flex items-center gap-3 mb-3">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center flex-none"
                  style={{ background: "rgba(59,130,246,0.10)", border: "1px solid rgba(59,130,246,0.20)" }}
                >
                  <span className="material-symbols-outlined" style={{ color: "#60A5FA", fontSize: 20 }}>
                    policy
                  </span>
                </div>
                <h2 className="font-headline font-semibold" style={{ fontSize: 22, color: "var(--color-on-surface)", letterSpacing: "-0.01em" }}>
                  Privacy &amp; your data rights
                </h2>
              </div>
              <p className="bv-body mb-5" style={{ color: "var(--color-on-surface-variant)", lineHeight: 1.6, maxWidth: "70ch" }}>
                We build toward a GDPR and KVKK posture: you can see what we hold, export it, and delete it.
                Because Braavolabs is BYOK and supports an on-device path, the most sensitive work can stay off
                our servers entirely.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  { icon: "delete", t: "Account & data deletion", d: "Delete your account and associated data on request." },
                  { icon: "download", t: "Export your data", d: "Take your workspace data with you when you want it." },
                  { icon: "vpn_key", t: "BYOK by default", d: "Your model keys, your prompts, your control." },
                  { icon: "wifi_off", t: "Stay off-cloud", d: "Run sensitive pipelines on-device or air-gapped." },
                ].map((item) => (
                  <div key={item.t} className="flex items-start gap-3">
                    <span className="material-symbols-outlined flex-none" style={{ color: "#60A5FA", fontSize: 18, marginTop: 1 }}>
                      {item.icon}
                    </span>
                    <div>
                      <div style={{ color: "var(--color-on-surface)", fontSize: 14, fontWeight: 500 }}>{item.t}</div>
                      <div style={{ color: "var(--color-on-surface-variant)", fontSize: 13, lineHeight: 1.5 }}>{item.d}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ── Compliance honesty note ── */}
        <section className="px-6 md:px-10 pt-6">
          <div className="max-w-5xl mx-auto">
            <div
              className="bv-glass"
              style={{ padding: "20px 24px", border: "1px solid rgba(255,122,26,0.18)", background: "rgba(255,122,26,0.03)" }}
            >
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined flex-none" style={{ color: "#FF7A1A", fontSize: 18, marginTop: 1 }}>
                  info
                </span>
                <p className="bv-body" style={{ color: "var(--color-on-surface-variant)", lineHeight: 1.6, maxWidth: "74ch" }}>
                  <span style={{ color: "var(--color-on-surface)", fontWeight: 500 }}>On certifications:</span> we
                  don&apos;t claim certifications we don&apos;t hold. SOC 2 readiness is on our roadmap — we&apos;ll
                  say so plainly, and we won&apos;t put a badge on this page until it&apos;s real. What&apos;s
                  described above reflects how the platform is built today.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ── Responsible disclosure ── */}
        <section className="px-6 md:px-10 pt-16 pb-4">
          <div className="max-w-5xl mx-auto">
            <div
              className="bv-glass flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6"
              style={{ padding: "30px 32px", border: "1px solid rgba(37,99,235,0.25)", background: "rgba(37,99,235,0.04)" }}
            >
              <div>
                <div className="bv-micro mb-2" style={{ color: "var(--color-outline)" }}>
                  Responsible disclosure
                </div>
                <p className="font-headline font-semibold mb-1" style={{ fontSize: 19, color: "var(--color-on-surface)" }}>
                  Found a security issue?
                </p>
                <p className="bv-body" style={{ color: "var(--color-on-surface-variant)", maxWidth: "60ch", lineHeight: 1.6 }}>
                  Please don&apos;t open a public issue. Email us a summary, a repro, and the impact. We aim to
                  acknowledge within 48 hours, triage within 5 business days, and credit you in the patch&apos;s
                  release notes (or omit your name on request).
                </p>
              </div>
              <a
                href="mailto:security@braavolabs.com"
                className="bv-btn bv-btn-primary bv-sheen whitespace-nowrap no-underline flex-none"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                  mail
                </span>
                security@braavolabs.com
              </a>
            </div>
          </div>
        </section>

        {/* ── Trust strip ── */}
        <section className="px-6 md:px-10 pt-14 pb-4 text-center">
          <div className="max-w-5xl mx-auto">
            <div className="bv-divider mb-8" />
            <p className="bv-mono" style={{ color: "var(--color-on-surface-variant)", letterSpacing: "0.04em", fontSize: 13 }}>
              Encrypted at rest · tenant-isolated · every spend approved · every run audited
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
                style={{ color: link.label === "Security" ? "var(--color-primary)" : "var(--color-on-surface-variant)" }}
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

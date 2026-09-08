"use client";

/**
 * Public account-deletion landing page.
 *
 * Required by:
 * - Google Play Data Safety (Feb 2024): apps that allow account creation
 *   must provide a publicly accessible URL where users can request
 *   account + data deletion without needing to install the app.
 * This page documents the deletion-request channel that is currently
 * evidenced and publicly reachable. It does not claim an in-app workflow.
 *
 * Linked from the marketing footer and listed in sitemap.ts.
 */

import { useTranslations } from "next-intl";

const sections = [
  {
    id: "overview",
    title: "Overview",
    icon: "info",
    content: (
      <>
        <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">
          You can ask Braavolabs to delete your account and associated personal data. The current public
          request channel is email, which lets us verify account ownership and confirm the request in writing.
        </p>
      </>
    ),
  },
  {
    id: "option-1",
    title: "Request deletion by email",
    icon: "mail",
    content: (
      <>
        <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">
          Send a message from the email address associated with your account to{" "}
          <a
            href="mailto:privacy@braavolabs.com?subject=Account%20deletion%20request"
            className="text-primary underline hover:text-primary-fixed transition-colors"
          >
            privacy@braavolabs.com
          </a>{" "}
          with the subject <em>&quot;Account deletion request&quot;</em>. Include the account email or username,
          but never send a password, API key, access token, or payment credential.
        </p>
      </>
    ),
  },
  {
    id: "option-2",
    title: "Verification and next steps",
    icon: "verified_user",
    content: (
      <>
        <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">
          We may ask for additional information needed to verify that you control the account. We will
          confirm the request and communicate its status through the verified email channel. Applicable
          statutory response periods continue to apply; this page does not promise an automated completion time.
        </p>
      </>
    ),
  },
  {
    id: "option-3",
    title: "Current availability",
    icon: "info",
    content: (
      <>
        <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">
          Braavolabs does not currently publish a separate deletion form or promise an in-app deletion
          control on this public site. Use the verified email channel above so the request is not lost or
          sent through an unrelated contact topic.
        </p>
      </>
    ),
  },
  {
    id: "what-gets-deleted",
    title: "What gets deleted",
    icon: "delete_forever",
    content: (
      <>
        <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">
          The deletion scope depends on the account records associated with the verified requester. We
          review that scope and confirm the outcome in writing, including any record that cannot lawfully
          be deleted.
        </p>
        <ul className="text-[15.5px] leading-[1.8] text-on-surface-variant pl-[22px] list-disc mb-[18px] space-y-2">
          <li>Account identity and profile records associated with the verified request</li>
          <li>Tenant-scoped content eligible for deletion under the applicable service and legal obligations</li>
          <li>Active credentials and sessions associated with the account, where technically and legally eligible</li>
        </ul>
      </>
    ),
  },
  {
    id: "what-we-retain",
    title: "What we retain — and why",
    icon: "archive",
    content: (
      <>
        <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">
          Some records may need to be retained for tax, accounting, dispute, fraud-prevention, or other
          legal obligations. The applicable categories and periods depend on the current deployment,
          provider contracts, and jurisdiction; they are communicated for the verified request rather
          than promised here as a fixed public schedule.
        </p>
        <ul className="text-[15.5px] leading-[1.8] text-on-surface-variant pl-[22px] list-disc mb-[18px] space-y-2">
          <li>Records that applicable tax, accounting, or regulatory law requires us to keep</li>
          <li>Records needed to document the request, verification, and legally required response</li>
          <li>Data subject to a valid legal hold or an unresolved dispute</li>
        </ul>
      </>
    ),
  },
  {
    id: "timeline",
    title: "Timeline",
    icon: "schedule",
    content: (
      <>
        <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">
          We process verified requests under the response periods required by applicable law and provide
          status updates through the verified email channel. Verification needs, legal holds, and lawful
          retention obligations can affect completion; any applicable limitation is explained in writing.
        </p>
      </>
    ),
  },
  {
    id: "active-subscriptions",
    title: "Active subscriptions",
    icon: "subscriptions",
    content: (
      <>
        <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">
          An account-deletion request and a billing cancellation are separate actions. If your account has
          a billing question, contact{" "}
          <a
            href="mailto:support@braavolabs.com"
            className="text-primary underline hover:text-primary-fixed transition-colors"
          >
            support@braavolabs.com
          </a>{" "}
          and we will identify the currently supported channel without claiming a store or in-app flow here.
        </p>
      </>
    ),
  },
  {
    id: "questions",
    title: "Questions",
    icon: "help",
    content: (
      <>
        <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">
          Any question about the process, the retention rules, or how to verify the deletion completed:{" "}
          <a
            href="mailto:privacy@braavolabs.com"
            className="text-primary underline hover:text-primary-fixed transition-colors"
          >
            privacy@braavolabs.com
          </a>
          . For broader data-rights inquiries (access, portability, rectification) see our{" "}
          <a href="/gdpr" className="text-primary underline hover:text-primary-fixed transition-colors">
            GDPR Statement
          </a>{" "}
          and{" "}
          <a href="/kvkk" className="text-primary underline hover:text-primary-fixed transition-colors">
            KVKK Aydınlatma Metni
          </a>
          .
        </p>
      </>
    ),
  },
];

export default function AccountDeletionPage() {
  const t = useTranslations();
  const legal = useTranslations("static.common.legalNavigation");

  return (
    <div className="min-h-screen bg-background bv-mesh">
      {/* ── Nav ── */}
      <nav className="sticky top-0 z-40 border-b border-outline-variant bg-surface/80 backdrop-blur-xl">
        <div className="max-w-[1100px] mx-auto flex items-center justify-between px-6 md:px-10 h-14">
          <a href="/" className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bv-btn-primary bv-btn">
              <span className="text-white font-bold text-xs leading-none">AI</span>
            </div>
            <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
          </a>
          <div className="hidden md:flex items-center gap-6">
            <a href="/features" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">Features</a>
            <a href="/pricing" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">Pricing</a>
            <a href="/about" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">About</a>
          </div>
          <div className="flex items-center gap-3">
            <a href="https://app.braavolabs.com/login" className="bv-btn bv-btn-ghost bv-btn-sm text-sm">Sign in</a>
            <a href="https://app.braavolabs.com" className="bv-btn bv-btn-primary bv-btn-sm text-sm bv-legal-cta">{legal("openApp")}</a>
          </div>
        </div>
      </nav>

      {/* ── Page header ── */}
      <header className="relative text-center pt-[clamp(56px,8vw,90px)] pb-10 overflow-hidden">
        {/* Watermark logo */}
        <div
          className="pointer-events-none absolute left-1/2 top-[10%] -translate-x-1/2 w-[280px] aspect-square opacity-[0.04]"
          style={{ WebkitMaskImage: "radial-gradient(circle,#000 60%,transparent 74%)", maskImage: "radial-gradient(circle,#000 60%,transparent 74%)" }}
          aria-hidden="true"
        >
          <div className="w-full h-full rounded-2xl bg-on-surface" />
        </div>

        <div className="relative max-w-[1100px] mx-auto px-6">
          {/* Eyebrow */}
          <div className="flex items-center justify-center gap-2 mb-4">
            <span className="bv-pill bv-pill-cyan">
              <span className="material-symbols-outlined" style={{ fontSize: 12 }}>gavel</span>
              {legal("legal")}
            </span>
          </div>

          <h1 className="font-headline font-semibold uppercase tracking-tight text-on-surface text-[clamp(34px,5vw,60px)] leading-[1.05] mb-3">
            Account &amp; Data Deletion
          </h1>
          <p className="bv-mono text-outline mt-3">Last updated: May 2026</p>

          {/* Doc switcher */}
          <div className="flex flex-wrap justify-center gap-2 mt-6">
            {[
              { label: legal("privacy"), href: "/privacy" },
              { label: legal("terms"), href: "/terms" },
              { label: legal("cookies"), href: "/cookies" },
              { label: "GDPR", href: "/gdpr" },
              { label: "KVKK", href: "/kvkk" },
              { label: legal("accountDeletion"), href: "/legal/account-deletion", active: true },
            ].map((doc) => (
              <a
                key={doc.href}
                href={doc.href}
                className={`bv-fpill ${doc.active ? "active" : ""}`}
              >
                {doc.label}
              </a>
            ))}
          </div>
        </div>
      </header>

      {/* ── Article grid (TOC + prose) ── */}
      <div className="max-w-[1040px] mx-auto px-6 md:px-8 mt-10 mb-24 grid grid-cols-1 md:grid-cols-[230px_1fr] gap-12">

        {/* Sticky TOC (desktop) */}
        <nav className="hidden md:block sticky top-[72px] self-start" aria-label={legal("onThisPage")}>
          <p className="bv-micro mb-[14px]">{legal("onThisPage")}</p>
          <div className="flex flex-col">
            {sections.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="text-[13px] leading-[1.3] text-on-surface-variant hover:text-on-surface py-[7px] px-[14px] border-l-2 border-outline-variant hover:border-primary transition-all"
              >
                {s.title}
              </a>
            ))}
          </div>
        </nav>

        {/* Prose */}
        <article className="max-w-[72ch] pb-24 bv-stagger">
          {sections.map((s) => (
            <section key={s.id} id={s.id} className="mb-0 scroll-mt-[90px]">
              {/* Section divider (skip first) */}
              <div className="bv-divider my-9 first:hidden" />

              <h2 className="font-headline font-semibold text-2xl uppercase tracking-tight text-on-surface mb-[14px] flex items-center gap-[10px] group">
                <span
                  className="material-symbols-outlined text-outline text-[20px] flex-shrink-0"
                  aria-hidden="true"
                >
                  {s.icon}
                </span>
                <span>{s.title}</span>
                <a
                  href={`#${s.id}`}
                  className="opacity-0 group-hover:opacity-100 text-[15px] text-primary no-underline transition-opacity"
                  aria-label={legal("permalinkTo", { title: s.title })}
                >
                  ¶
                </a>
              </h2>

              {s.content}
            </section>
          ))}

          {/* CTA card */}
          <div className="mt-10 bv-glass p-6 flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div className="flex-1">
              <p className="bv-title mb-1">Ready to delete your account?</p>
              <p className="bv-caption">
                Send the request from the email address associated with your account.
              </p>
            </div>
            <div className="flex gap-3 flex-shrink-0">
              <a
                href="mailto:privacy@braavolabs.com?subject=Account%20deletion%20request"
                className="bv-btn bv-btn-ghost bv-btn-sm"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>mail</span>
                Email us
              </a>
            </div>
          </div>
        </article>
      </div>

      {/* ── Footer ── */}
      <footer className="border-t border-outline-variant">
        <div className="max-w-[1100px] mx-auto px-6 md:px-10 py-12">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-10">
            <div className="col-span-2 md:col-span-1">
              <a href="/" className="flex items-center gap-2.5 mb-3">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center bv-btn-primary bv-btn bv-btn-icon" style={{ padding: 0, minWidth: 28, minHeight: 28, width: 28, height: 28 }}>
                  <span className="text-white font-bold text-[10px] leading-none">AI</span>
                </div>
                <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
              </a>
              <p className="text-sm text-on-surface-variant leading-relaxed">
                Command the AI agents &amp; automations you already run.
              </p>
            </div>
            <div>
              <h5 className="bv-micro mb-3">Product</h5>
              <div className="flex flex-col gap-2">
                <a href="/features" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">Features</a>
                <a href="/pricing" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">Pricing</a>
                <a href="/changelog" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">Changelog</a>
              </div>
            </div>
            <div>
              <h5 className="bv-micro mb-3">Company</h5>
              <div className="flex flex-col gap-2">
                <a href="/about" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">About</a>
                <a href="/blog" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">Blog</a>
                <a href="/contact" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">Contact</a>
              </div>
            </div>
            <div>
              <h5 className="bv-micro mb-3">{legal("legal")}</h5>
              <div className="flex flex-col gap-2">
                <a href="/privacy" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">{legal("privacy")}</a>
                <a href="/terms" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">{legal("terms")}</a>
                <a href="/kvkk" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">KVKK</a>
                <a href="/gdpr" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">GDPR</a>
              </div>
            </div>
          </div>
          <div className="bv-divider" />
          <p className="text-sm text-outline mt-6 text-center">
            &copy; {new Date().getFullYear()} Braavolabs. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}

"use client";

/**
 * Public account-deletion landing page.
 *
 * Required by:
 * - Google Play Data Safety (Feb 2024): apps that allow account creation
 *   must provide a publicly accessible URL where users can request
 *   account + data deletion without needing to install the app.
 * - Apple App Store Guideline 5.1.1(v): in-app deletion exists in
 *   /settings/delete-account on mobile; this page is the externally
 *   reachable mirror for users who already uninstalled.
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
          You can permanently delete your Braavolabs account and the data we hold for you at any time.
          There are three ways to request deletion — pick whichever is most convenient. Every route hits
          the same cascade and the same retention rules, so the outcome is identical.
        </p>
      </>
    ),
  },
  {
    id: "option-1",
    title: "Option 1 — Delete from inside the app (fastest)",
    icon: "smartphone",
    content: (
      <>
        <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">
          Open Braavolabs on mobile (iOS or Android), go to{" "}
          <strong className="text-on-surface font-medium">Settings → Delete account</strong>, type{" "}
          <code className="font-mono text-sm bg-surface-container-high px-[6px] py-[2px] rounded text-primary">
            DELETE
          </code>{" "}
          into the confirmation box, then tap the destructive button. The cascade runs immediately.
          On web, the same flow lives under{" "}
          <strong className="text-on-surface font-medium">Settings → Privacy → Delete account</strong>.
        </p>
      </>
    ),
  },
  {
    id: "option-2",
    title: "Option 2 — Email request (recommended if you no longer have the app installed)",
    icon: "mail",
    content: (
      <>
        <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">
          Send a message from the email address on your account to{" "}
          <a
            href="mailto:privacy@braavolabs.com?subject=Account%20deletion%20request"
            className="text-primary underline hover:text-primary-fixed transition-colors"
          >
            privacy@braavolabs.com
          </a>{" "}
          with the subject <em>&quot;Account deletion request&quot;</em>. Include the email or username you signed
          up with. We confirm receipt within 1 business day and complete the deletion within 30 days
          (GDPR Article 12(3) / KVKK 13. madde).
        </p>
      </>
    ),
  },
  {
    id: "option-3",
    title: "Option 3 — Web form",
    icon: "web",
    content: (
      <>
        <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">
          Visit{" "}
          <a
            href="/contact?topic=delete"
            className="text-primary underline hover:text-primary-fixed transition-colors"
          >
            braavolabs.com/contact
          </a>{" "}
          and select &quot;Delete my account&quot; from the topic dropdown. The form does not require you to be
          logged in; you only need to prove control of the email address tied to your account before
          we run the cascade.
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
          When the request completes, the following are removed from production storage and from every
          hot replica:
        </p>
        <ul className="text-[15.5px] leading-[1.8] text-on-surface-variant pl-[22px] list-disc mb-[18px] space-y-2">
          <li>Your profile (name, email, password hash, OAuth links, profile photo)</li>
          <li>Your tenant and every company you created inside it</li>
          <li>Every pipeline, agent, draft, and run history record (run steps, tool calls, approvals)</li>
          <li>Encrypted credentials and integration tokens (HubSpot, Stripe Connect, GitHub, etc.)</li>
          <li>Memory items, embeddings, and graph edges scoped to your tenant</li>
          <li>Mobile push tokens, refresh tokens, and active sessions</li>
          <li>Marketing email subscriptions and onboarding email queues</li>
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
          A small set of records is retained after deletion because the law requires it or the data is
          already anonymised:
        </p>
        <ul className="text-[15.5px] leading-[1.8] text-on-surface-variant pl-[22px] list-disc mb-[18px] space-y-2">
          <li>
            <strong className="text-on-surface font-medium">Financial records</strong> — invoices, Stripe charges, IAP receipts,
            refund decisions: retained for the period required by tax and accounting law in the user&apos;s
            jurisdiction (typically 6–10 years).
          </li>
          <li>
            <strong className="text-on-surface font-medium">Aggregated, anonymised usage metrics</strong> — counts of pipeline runs,
            LLM token totals, error rates with no link back to your identity.
          </li>
          <li>
            <strong className="text-on-surface font-medium">Audit log entries that mention your user ID for compliance investigations</strong>{" "}
            — retained for up to 12 months and then automatically purged.
          </li>
          <li>
            <strong className="text-on-surface font-medium">Encrypted off-site backups</strong> — overwritten on the rolling backup
            cycle (90 days). We do not selectively redact within a backup file; instead the file ages
            out and is replaced with a backup taken after your deletion.
          </li>
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
          In-app deletion runs synchronously: the cascade completes in seconds and you are signed out
          immediately. Email and form requests are answered within 1 business day and the cascade
          completes within 30 calendar days, in line with GDPR Article 12(3) and KVKK Madde 13. If a
          legal hold prevents us from deleting on time we will tell you in writing within the same
          window and explain why.
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
          Deleting your account does not automatically cancel a paid subscription billed through Apple
          or Google. Cancel from{" "}
          <strong className="text-on-surface font-medium">Settings → Subscriptions</strong> on your device first
          (or via the App Store / Google Play account screen), then run the deletion. If you delete
          first, contact{" "}
          <a
            href="mailto:support@braavolabs.com"
            className="text-primary underline hover:text-primary-fixed transition-colors"
          >
            support@braavolabs.com
          </a>{" "}
          and we will help reconcile the remaining billing period.
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
            <a href="https://app.braavolabs.com/register" className="bv-btn bv-btn-primary bv-btn-sm text-sm">Choose a plan</a>
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
              Legal
            </span>
          </div>

          <h1 className="font-headline font-semibold uppercase tracking-tight text-on-surface text-[clamp(34px,5vw,60px)] leading-[1.05] mb-3">
            Account &amp; Data Deletion
          </h1>
          <p className="bv-mono text-outline mt-3">Last updated: May 2026</p>

          {/* Doc switcher */}
          <div className="flex flex-wrap justify-center gap-2 mt-6">
            {[
              { label: "Privacy", href: "/privacy" },
              { label: "Terms", href: "/terms" },
              { label: "Cookies", href: "/cookies" },
              { label: "GDPR", href: "/gdpr" },
              { label: "KVKK", href: "/kvkk" },
              { label: "Account deletion", href: "/legal/account-deletion", active: true },
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
        <nav className="hidden md:block sticky top-[72px] self-start" aria-label="On this page">
          <p className="bv-micro mb-[14px]">On this page</p>
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
                  aria-label={`Link to ${s.title}`}
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
                The fastest path is directly from the app. If you no longer have access, email us.
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
              <a
                href="/contact?topic=delete"
                className="bv-btn bv-btn-primary bv-btn-sm"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>open_in_new</span>
                Web form
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
              <h5 className="bv-micro mb-3">Legal</h5>
              <div className="flex flex-col gap-2">
                <a href="/privacy" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">Privacy</a>
                <a href="/terms" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">Terms</a>
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

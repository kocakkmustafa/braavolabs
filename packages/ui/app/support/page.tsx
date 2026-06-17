/**
 * Public support landing page.
 *
 * Required by:
 * - Apple App Store Guideline 1.5: the Support URL in App Store Connect
 *   must resolve to a functional webpage with support information.
 *   ASC points at braavolabs.com/destek which 301s here (next.config.ts).
 * - Google Play store listing support expectations.
 *
 * Linked from the marketing footer and listed in sitemap.ts.
 */

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Support — Braavolabs",
  description:
    "Get help with Braavolabs: contact channels, response times, billing and subscription help, account deletion, and frequently asked questions.",
  alternates: { canonical: "https://braavolabs.com/support" },
  openGraph: {
    title: "Braavolabs Support",
    description:
      "Contact channels, response times, billing and subscription help, account deletion, and frequently asked questions.",
    url: "https://braavolabs.com/support",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

const sections = [
  {
    id: "contact",
    title: "Contact support",
    icon: "support_agent",
    content: (
      <>
        <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">
          The fastest way to reach a human is email. Write to{" "}
          <a
            href="mailto:support@braavolabs.com"
            className="text-primary underline hover:text-primary-fixed transition-colors"
          >
            support@braavolabs.com
          </a>{" "}
          from any address — include the email you signed up with so we can locate your account. We
          answer within <strong className="text-on-surface font-medium">1 business day</strong>, usually much
          faster. You can also use the{" "}
          <a href="/contact" className="text-primary underline hover:text-primary-fixed transition-colors">
            contact form
          </a>{" "}
          if you prefer not to open your mail client.
        </p>
        <ul className="text-[15.5px] leading-[1.8] text-on-surface-variant pl-[22px] list-disc mb-[18px] space-y-2">
          <li>
            <strong className="text-on-surface font-medium">Billing &amp; subscriptions</strong> —{" "}
            <a href="mailto:support@braavolabs.com" className="text-primary underline hover:text-primary-fixed transition-colors">
              support@braavolabs.com
            </a>
          </li>
          <li>
            <strong className="text-on-surface font-medium">Privacy &amp; data rights</strong> —{" "}
            <a href="mailto:privacy@braavolabs.com" className="text-primary underline hover:text-primary-fixed transition-colors">
              privacy@braavolabs.com
            </a>
          </li>
          <li>
            <strong className="text-on-surface font-medium">Security reports</strong> —{" "}
            <a href="mailto:security@braavolabs.com" className="text-primary underline hover:text-primary-fixed transition-colors">
              security@braavolabs.com
            </a>
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "subscriptions",
    title: "Subscriptions, purchases & refunds",
    icon: "subscriptions",
    content: (
      <>
        <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">
          Mobile subscriptions are billed by Apple or Google, not by us, and renew automatically until
          cancelled. To view, change, or cancel: on iOS open{" "}
          <strong className="text-on-surface font-medium">Settings → your name → Subscriptions</strong>; on
          Android open <strong className="text-on-surface font-medium">Google Play → Profile → Payments &amp;
          subscriptions</strong>. Refunds for store purchases are handled by Apple
          (reportaproblem.apple.com) or Google Play according to their policies — if you get stuck,
          email us and we will help you through it. Web subscriptions billed via Stripe can be managed
          from <strong className="text-on-surface font-medium">Settings → Billing</strong> inside the app.
        </p>
      </>
    ),
  },
  {
    id: "faq",
    title: "Frequent questions",
    icon: "quiz",
    content: (
      <>
        <ul className="text-[15.5px] leading-[1.8] text-on-surface-variant pl-[22px] list-disc mb-[18px] space-y-2">
          <li>
            <strong className="text-on-surface font-medium">Which AI providers does Braavolabs use?</strong>{" "}
            Braavolabs is bring-your-own-key: your workspace only talks to the providers you connect
            in <em>Settings → AI Providers</em> (Anthropic, OpenAI, Google, Mistral, Groq, and others),
            or to the built-in trial pool while you evaluate. Run history shows every call an agent
            makes.
          </li>
          <li>
            <strong className="text-on-surface font-medium">Why is my pipeline paused?</strong> Risk stops
            (budget overruns, repeated failures, spend approvals waiting) pause runs automatically.
            Check <em>Approvals</em> in the app — approving or editing the pending step resumes the run.
          </li>
          <li>
            <strong className="text-on-surface font-medium">How do I delete my account?</strong> In the app:{" "}
            <em>Settings → Delete account</em>. Without the app, follow the steps on the{" "}
            <a href="/legal/account-deletion" className="text-primary underline hover:text-primary-fixed transition-colors">
              account &amp; data deletion
            </a>{" "}
            page.
          </li>
          <li>
            <strong className="text-on-surface font-medium">Is the platform up?</strong> Live service health is
            published on the{" "}
            <a href="/status" className="text-primary underline hover:text-primary-fixed transition-colors">
              status page
            </a>
            .
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "report-a-problem",
    title: "Report a bug",
    icon: "bug_report",
    content: (
      <>
        <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">
          Email{" "}
          <a
            href="mailto:support@braavolabs.com?subject=Bug%20report"
            className="text-primary underline hover:text-primary-fixed transition-colors"
          >
            support@braavolabs.com
          </a>{" "}
          with what you expected, what happened instead, and roughly when it happened. On mobile,
          attaching a screenshot and your app version (shown at the bottom of{" "}
          <strong className="text-on-surface font-medium">Settings</strong>) shortens the round-trip
          considerably.
        </p>
      </>
    ),
  },
  {
    id: "legal",
    title: "Policies",
    icon: "gavel",
    content: (
      <>
        <p className="text-[15.5px] leading-[1.8] text-on-surface-variant mb-[18px]">
          Everything we promise in writing:{" "}
          <a href="/privacy" className="text-primary underline hover:text-primary-fixed transition-colors">
            Privacy Policy
          </a>
          ,{" "}
          <a href="/terms" className="text-primary underline hover:text-primary-fixed transition-colors">
            Terms of Use
          </a>
          ,{" "}
          <a href="/gdpr" className="text-primary underline hover:text-primary-fixed transition-colors">
            GDPR Statement
          </a>
          ,{" "}
          <a href="/kvkk" className="text-primary underline hover:text-primary-fixed transition-colors">
            KVKK Aydınlatma Metni
          </a>{" "}
          and the{" "}
          <a href="/legal/account-deletion" className="text-primary underline hover:text-primary-fixed transition-colors">
            account &amp; data deletion
          </a>{" "}
          process.
        </p>
      </>
    ),
  },
];

export default function SupportPage() {
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
            <a href="/login" className="bv-btn bv-btn-ghost bv-btn-sm text-sm">Sign in</a>
            <a href="/register" className="bv-btn bv-btn-primary bv-btn-sm text-sm">Start free</a>
          </div>
        </div>
      </nav>

      {/* ── Page header ── */}
      <header className="relative text-center pt-[clamp(56px,8vw,90px)] pb-10 overflow-hidden">
        <div className="relative max-w-[1100px] mx-auto px-6">
          <div className="flex items-center justify-center gap-2 mb-4">
            <span className="bv-pill bv-pill-cyan">
              <span className="material-symbols-outlined" style={{ fontSize: 12 }}>support_agent</span>
              Support
            </span>
          </div>

          <h1 className="font-headline font-semibold uppercase tracking-tight text-on-surface text-[clamp(34px,5vw,60px)] leading-[1.05] mb-3">
            How can we help?
          </h1>
          <p className="text-on-surface-variant max-w-[60ch] mx-auto">
            Real answers from the people who build Braavolabs — typically within one business day.
          </p>

          <div className="flex flex-wrap justify-center gap-3 mt-8">
            <a href="mailto:support@braavolabs.com" className="bv-btn bv-btn-primary bv-btn-sm">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>mail</span>
              Email support
            </a>
            <a href="/contact" className="bv-btn bv-btn-ghost bv-btn-sm">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>edit_note</span>
              Contact form
            </a>
            <a href="/status" className="bv-btn bv-btn-ghost bv-btn-sm">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>monitor_heart</span>
              Service status
            </a>
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
              <p className="bv-title mb-1">Still stuck?</p>
              <p className="bv-caption">
                Write to us — a founder reads every message, in English or Turkish.
              </p>
            </div>
            <div className="flex gap-3 flex-shrink-0">
              <a href="mailto:support@braavolabs.com" className="bv-btn bv-btn-primary bv-btn-sm">
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>mail</span>
                support@braavolabs.com
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

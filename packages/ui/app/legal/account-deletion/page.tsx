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

export default function AccountDeletionPage() {
  const t = useTranslations();

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
        <a href="/" className="text-sm hover:text-white transition-colors" style={{ color: "#859399" }}>
          {t("static.common.back")}
        </a>
      </nav>

      <div className="max-w-[720px] mx-auto px-6 py-16">
        <div className="mb-10">
          <h1 className="font-headline font-extrabold mb-2" style={{ fontSize: "2rem", color: "#e1e2eb" }}>
            Account &amp; Data Deletion
          </h1>
          <p className="text-sm" style={{ color: "#3c494e" }}>Last updated: May 2026</p>
        </div>

        <div className="space-y-8 text-sm leading-relaxed" style={{ color: "#859399" }}>
          <div>
            <h2 className="font-headline font-semibold text-sm mb-2" style={{ color: "#e1e2eb" }}>Overview</h2>
            <p>
              You can permanently delete your Braavolabs account and the data we hold for you at any time.
              There are three ways to request deletion — pick whichever is most convenient. Every route hits
              the same cascade and the same retention rules, so the outcome is identical.
            </p>
          </div>

          <div>
            <h2 className="font-headline font-semibold text-sm mb-2" style={{ color: "#e1e2eb" }}>Option 1 — Delete from inside the app (fastest)</h2>
            <p>
              Open Braavolabs on mobile (iOS or Android), go to <strong style={{ color: "#bbc9cf" }}>Settings → Delete account</strong>,
              type <code style={{ background: "rgba(255,255,255,0.04)", padding: "2px 6px", borderRadius: 4, color: "#a4e6ff" }}>DELETE</code>
              {" "}into the confirmation box, then tap the destructive button. The cascade runs immediately.
              On web, the same flow lives under <strong style={{ color: "#bbc9cf" }}>Settings → Privacy → Delete account</strong>.
            </p>
          </div>

          <div>
            <h2 className="font-headline font-semibold text-sm mb-2" style={{ color: "#e1e2eb" }}>Option 2 — Email request (recommended if you no longer have the app installed)</h2>
            <p>
              Send a message from the email address on your account to{" "}
              <a href="mailto:privacy@braavolabs.com?subject=Account%20deletion%20request" style={{ color: "#a4e6ff", textDecoration: "underline" }}>
                privacy@braavolabs.com
              </a>{" "}
              with the subject <em>&quot;Account deletion request&quot;</em>. Include the email or username you signed
              up with. We confirm receipt within 1 business day and complete the deletion within 30 days
              (GDPR Article 12(3) / KVKK 13. madde).
            </p>
          </div>

          <div>
            <h2 className="font-headline font-semibold text-sm mb-2" style={{ color: "#e1e2eb" }}>Option 3 — Web form</h2>
            <p>
              Visit{" "}
              <a href="/contact?topic=delete" style={{ color: "#a4e6ff", textDecoration: "underline" }}>
                braavolabs.com/contact
              </a>{" "}
              and select &quot;Delete my account&quot; from the topic dropdown. The form does not require you to be
              logged in; you only need to prove control of the email address tied to your account before
              we run the cascade.
            </p>
          </div>

          <div>
            <h2 className="font-headline font-semibold text-sm mb-2" style={{ color: "#e1e2eb" }}>What gets deleted</h2>
            <p>
              When the request completes, the following are removed from production storage and from every
              hot replica:
            </p>
            <ul style={{ marginTop: 8, paddingLeft: 20, listStyle: "disc" }}>
              <li>Your profile (name, email, password hash, OAuth links, profile photo)</li>
              <li>Your tenant and every company you created inside it</li>
              <li>Every pipeline, agent, draft, and run history record (run steps, tool calls, approvals)</li>
              <li>Encrypted credentials and integration tokens (HubSpot, Stripe Connect, GitHub, etc.)</li>
              <li>Memory items, embeddings, and graph edges scoped to your tenant</li>
              <li>Mobile push tokens, refresh tokens, and active sessions</li>
              <li>Marketing email subscriptions and onboarding email queues</li>
            </ul>
          </div>

          <div>
            <h2 className="font-headline font-semibold text-sm mb-2" style={{ color: "#e1e2eb" }}>What we retain — and why</h2>
            <p>
              A small set of records is retained after deletion because the law requires it or the data is
              already anonymised:
            </p>
            <ul style={{ marginTop: 8, paddingLeft: 20, listStyle: "disc" }}>
              <li>
                <strong style={{ color: "#bbc9cf" }}>Financial records</strong> — invoices, Stripe charges, IAP receipts,
                refund decisions: retained for the period required by tax and accounting law in the user&apos;s
                jurisdiction (typically 6–10 years).
              </li>
              <li>
                <strong style={{ color: "#bbc9cf" }}>Aggregated, anonymised usage metrics</strong> — counts of pipeline runs,
                LLM token totals, error rates with no link back to your identity.
              </li>
              <li>
                <strong style={{ color: "#bbc9cf" }}>Audit log entries that mention your user ID for compliance investigations</strong>{" "}
                — retained for up to 12 months and then automatically purged.
              </li>
              <li>
                <strong style={{ color: "#bbc9cf" }}>Encrypted off-site backups</strong> — overwritten on the rolling backup
                cycle (90 days). We do not selectively redact within a backup file; instead the file ages
                out and is replaced with a backup taken after your deletion.
              </li>
            </ul>
          </div>

          <div>
            <h2 className="font-headline font-semibold text-sm mb-2" style={{ color: "#e1e2eb" }}>Timeline</h2>
            <p>
              In-app deletion runs synchronously: the cascade completes in seconds and you are signed out
              immediately. Email and form requests are answered within 1 business day and the cascade
              completes within 30 calendar days, in line with GDPR Article 12(3) and KVKK Madde 13. If a
              legal hold prevents us from deleting on time we will tell you in writing within the same
              window and explain why.
            </p>
          </div>

          <div>
            <h2 className="font-headline font-semibold text-sm mb-2" style={{ color: "#e1e2eb" }}>Active subscriptions</h2>
            <p>
              Deleting your account does not automatically cancel a paid subscription billed through Apple
              or Google. Cancel from <strong style={{ color: "#bbc9cf" }}>Settings → Subscriptions</strong> on your device first
              (or via the App Store / Google Play account screen), then run the deletion. If you delete
              first, contact{" "}
              <a href="mailto:support@braavolabs.com" style={{ color: "#a4e6ff", textDecoration: "underline" }}>
                support@braavolabs.com
              </a>{" "}
              and we will help reconcile the remaining billing period.
            </p>
          </div>

          <div>
            <h2 className="font-headline font-semibold text-sm mb-2" style={{ color: "#e1e2eb" }}>Questions</h2>
            <p>
              Any question about the process, the retention rules, or how to verify the deletion completed:{" "}
              <a href="mailto:privacy@braavolabs.com" style={{ color: "#a4e6ff", textDecoration: "underline" }}>
                privacy@braavolabs.com
              </a>
              . For broader data-rights inquiries (access, portability, rectification) see our{" "}
              <a href="/gdpr" style={{ color: "#a4e6ff", textDecoration: "underline" }}>GDPR Statement</a>{" "}
              and{" "}
              <a href="/kvkk" style={{ color: "#a4e6ff", textDecoration: "underline" }}>KVKK Aydınlatma Metni</a>.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

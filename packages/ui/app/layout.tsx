import type { Metadata } from "next";
import "./globals.css";
import AuthLayout from "./AuthLayout";
import { ToastProvider } from "../components/Toast";
import CookieConsent from "../components/CookieConsent";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";

// These are the SITE-WIDE DEFAULTS: the title a page without its own falls
// back to, and — because `openGraph`/`twitter` are inherited, not per-page —
// the card every shared link renders with. They kept describing the landing
// page that was deleted on 2026-07-25 ("Your AI company, built in 10 minutes",
// "runs while you sleep"), so the old positioning outlived the old homepage in
// exactly the places nobody looks at while editing a page: search snippets and
// link previews. The wording below is not new copy — it is lifted from the
// approved homepage comp and from `app/page.tsx`, so the two cannot drift.
export const metadata: Metadata = {
  title: {
    default: "Braavolabs — Every agent needs a gate",
    template: "%s | Braavolabs",
  },
  description: "Governed agents, a multi-model council, an auditable ledger, and a desktop app that runs on your own machine. Every risky step passes an approval gate.",
  keywords: ["Braavolabs", "AI agents", "agent governance", "approval gate", "audit log", "multi-model", "BYOK", "desktop app", "CLI", "Claude", "local-first"],
  authors: [{ name: "Braavolabs" }],
  openGraph: {
    title: "Braavolabs — Every agent needs a gate",
    description: "Governed agents, a multi-model council, an auditable ledger, and a desktop app that runs on your own machine. Every risky step passes an approval gate.",
    type: "website",
    siteName: "Braavolabs",
    url: "https://braavolabs.com",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Braavolabs — Every agent needs a gate",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Braavolabs — Every agent needs a gate",
    description: "Governed agents, a multi-model council, an auditable ledger, and a desktop app that runs on your own machine.",
    images: ["/og-image.png"],
  },
  // Next.js 15 picks up app/icon.png and app/apple-icon.png automatically
  // — both shipped from the user-supplied emblem (256×256 source). The
  // explicit `icons.icon` block is intentionally omitted so we don't
  // double-register and confuse browsers.
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://braavolabs.com"),
  alternates: { canonical: "https://braavolabs.com" },
  // Search-engine ownership verification. We support multiple providers
  // because each rolls out features at different speeds — Google for
  // classic SERP/sitelinks, Bing for Copilot grounding, Yandex for CIS
  // traffic. Tag values come from env vars so DNS-TXT alternative
  // remains an option (the meta tag is a fallback path; we ship both).
  // Setting the env var to an empty string omits the tag, so missing
  // values are safe.
  verification: {
    google: process.env.GOOGLE_SITE_VERIFICATION || undefined,
    yandex: process.env.YANDEX_VERIFICATION || undefined,
    other: process.env.BING_SITE_VERIFICATION
      ? { "msvalidate.01": process.env.BING_SITE_VERIFICATION }
      : undefined,
  },
};

// Site-wide JSON-LD structured data — picked up by Google rich results,
// Bing, and AI assistants (ChatGPT, Claude, Perplexity, Gemini) when they
// scrape for citation signals. Three @graph nodes:
//   1. Organization — official brand entity
//   2. WebSite — sitelinks search box, brand name canonical
//   3. SoftwareApplication — pricing offers, app category, rating slot
// Earlier the site shipped zero JSON-LD; AI Visibility (Brand Radar) was
// blind to our pricing tier breakdown and product framing.
const SCHEMA_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://braavolabs.com/#organization",
      name: "Braavolabs",
      url: "https://braavolabs.com",
      logo: "https://braavolabs.com/braavolabs-logo.png",
      foundingDate: "2026",
      contactPoint: [
        {
          "@type": "ContactPoint",
          contactType: "customer support",
          email: "support@braavolabs.com",
          availableLanguage: ["English", "Turkish"],
        },
        {
          "@type": "ContactPoint",
          contactType: "sales",
          email: "founder@braavolabs.com",
          availableLanguage: ["English", "Turkish"],
        },
      ],
    },
    {
      "@type": "WebSite",
      "@id": "https://braavolabs.com/#website",
      url: "https://braavolabs.com",
      name: "Braavolabs",
      description:
        "The governed command center for your AI agents. One panel for every model, an approval gate on every risky step, and a full ledger of what ran.",
      publisher: { "@id": "https://braavolabs.com/#organization" },
      inLanguage: "en",
    },
    {
      "@type": "SoftwareApplication",
      "@id": "https://braavolabs.com/#software",
      name: "Braavolabs",
      applicationCategory: "DeveloperApplication",
      applicationSubCategory: "AI Agent Platform",
      // The product this page sells is the desktop app and the CLI; the web
      // surface is marketing plus account/billing. Keep this list in step with
      // the download buttons on the homepage — if a platform ships or stops
      // shipping, both change together.
      operatingSystem: "macOS, Windows",
      url: "https://braavolabs.com",
      description:
        "A governed command center for AI agents. Runs on your own machine across three lanes — local models, provider APIs, and your existing vendor CLI subscription. Every risky step passes an approval gate, every command and tool call lands in an auditable ledger, and one kill switch stops every session at once. BYOK with no token markup; AES-256-GCM at-rest credential encryption.",
      offers: [
        { "@type": "Offer", name: "Free", price: "0", priceCurrency: "USD", availability: "https://schema.org/InStock" },
        { "@type": "Offer", name: "Creator", price: "19", priceCurrency: "USD", availability: "https://schema.org/InStock" },
        { "@type": "Offer", name: "Pro", price: "39", priceCurrency: "USD", availability: "https://schema.org/InStock" },
        { "@type": "Offer", name: "Business", price: "99", priceCurrency: "USD", availability: "https://schema.org/InStock" },
        { "@type": "Offer", name: "Enterprise", priceCurrency: "USD", description: "Custom pricing — contact sales@braavolabs.com" },
      ],
      featureList: [
        "Approval gate on every risky step",
        "Auditable ledger — every command, diff and tool call recorded",
        "One kill switch across sessions, hosts and vendor CLIs",
        "Multi-model council — cascade and compare across providers",
        "Model-agnostic memory that outlives any single model",
        "Multi-model handoff — one agent passes the thread to the next",
        "Three lanes: local models, provider APIs, your own CLI subscription",
        "BYOK with zero token markup",
        "Mobile companion — approve, deny or steer from your phone",
        "Risk stops (cost anomaly, loop detection, brand violation, spam)",
        "KVKK + GDPR compliant",
      ],
    },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // next-intl resolves locale from cookie / Accept-Language (see i18n/request.ts).
  // Arabic (and any future RTL locale) flips dir="rtl" so the whole tree
  // mirrors automatically.
  const locale = await getLocale();
  const messages = await getMessages();
  const isRtl = locale === "ar";
  return (
    <html lang={locale} dir={isRtl ? "rtl" : "ltr"} className="dark" suppressHydrationWarning data-scroll-behavior="smooth">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Preload Material Symbols font CSS to avoid FOIT on first load (BUG-04) */}
        <link rel="preload" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" as="style" />
        <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
        <link rel="preload" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" as="style" />
        <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet" />
        {/* Site-wide JSON-LD structured data — Organization + WebSite +
            SoftwareApplication. AI assistants and search engines parse this
            for rich result eligibility and citation signals. */}
        <script
          type="application/ld+json"
          // dangerouslySetInnerHTML is correct here: JSON.stringify gives us
          // a known-safe payload (we control the literal above).
          dangerouslySetInnerHTML={{ __html: JSON.stringify(SCHEMA_LD) }}
        />
        {/* Plausible Analytics — privacy-first, no cookies, KVKK-compliant.
            Loaded only when NEXT_PUBLIC_PLAUSIBLE_DOMAIN is set, so the
            tag is dormant until the user activates a Plausible account
            and ships a build with the env var. The CookieConsent banner
            doesn't gate this because Plausible doesn't use cookies and
            doesn't fingerprint — explicit Plausible position. */}
        {process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN && (
          <script
            defer
            data-domain={process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN}
            src="https://plausible.io/js/script.outbound-links.js"
          />
        )}
      </head>
      <body className="bg-background text-on-surface antialiased">
        {/* Skip-link — keyboard users can bypass nav and jump to <main>. */}
        <a href="#main-content" className="skip-link">Skip to main content</a>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ToastProvider>
            <AuthLayout>
              {children}
            </AuthLayout>
            {/* KVKK/GDPR cookie consent — self-renders only when not yet decided */}
            <CookieConsent />
          </ToastProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

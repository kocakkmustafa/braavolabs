import type { Metadata } from "next";
import "./globals.css";
import AuthLayout from "./AuthLayout";
import { ToastProvider } from "../components/Toast";
import CookieConsent from "../components/CookieConsent";

export const metadata: Metadata = {
  title: {
    default: "Braavolabs — Your AI company, built in 10 minutes",
    template: "%s | Braavolabs",
  },
  description: "Describe your business in plain English. Braavolabs builds a fully-staffed autonomous company — content, sales, ops — that runs while you sleep. Every decision logged.",
  keywords: ["Braavolabs", "AI", "autonomous company", "AI agents", "automation", "pipeline", "Claude"],
  authors: [{ name: "Braavolabs" }],
  openGraph: {
    title: "Braavolabs — Your AI company, built in 10 minutes",
    description: "Describe your business in plain English. Braavolabs builds a fully-staffed autonomous company — content, sales, ops — that runs while you sleep.",
    type: "website",
    siteName: "Braavolabs",
  },
  twitter: {
    card: "summary_large_image",
    title: "Braavolabs — Your AI company, built in 10 minutes",
    description: "Describe your business in plain English. Braavolabs builds an autonomous company that runs while you sleep.",
  },
  icons: {
    icon: [
      { url: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0%' stop-color='%2300d1ff'/><stop offset='100%' stop-color='%236d11ad'/></linearGradient></defs><rect width='32' height='32' rx='8' fill='url(%23g)'/><text x='16' y='22' font-size='14' font-weight='bold' text-anchor='middle' fill='white' font-family='sans-serif'>AI</text></svg>", type: "image/svg+xml" },
    ],
  },
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "http://localhost:3001"),
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
      logo: "https://braavolabs.com/og-image.png",
      sameAs: [
        // Filled in once social accounts are public — keep array shape
        // here so AI assistants pick up the schema even when empty.
      ],
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
        "Your AI company, built in 10 minutes. Describe your business in plain English — Braavolabs assembles a fully-staffed autonomous company that runs while you sleep.",
      publisher: { "@id": "https://braavolabs.com/#organization" },
      inLanguage: "en",
    },
    {
      "@type": "SoftwareApplication",
      "@id": "https://braavolabs.com/#software",
      name: "Braavolabs",
      applicationCategory: "BusinessApplication",
      applicationSubCategory: "AI Agent Platform",
      operatingSystem: "Web (any modern browser)",
      url: "https://braavolabs.com",
      description:
        "Autonomous AI company creation platform. 9 primitives (Acquisition, Sales, Delivery, Content, Operations, Finance, Analytics, Memory, Governance) compose into agents and pipelines. Every action audit-logged with explicit reasoning. BYOK Anthropic API keys; AES-256-GCM at-rest credential encryption.",
      offers: [
        { "@type": "Offer", name: "Free", price: "0", priceCurrency: "USD", availability: "https://schema.org/InStock" },
        { "@type": "Offer", name: "Creator", price: "19", priceCurrency: "USD", availability: "https://schema.org/InStock" },
        { "@type": "Offer", name: "Pro", price: "39", priceCurrency: "USD", availability: "https://schema.org/InStock" },
        { "@type": "Offer", name: "Business", price: "99", priceCurrency: "USD", availability: "https://schema.org/InStock" },
        { "@type": "Offer", name: "Enterprise", priceCurrency: "USD", priceSpecification: { "@type": "PriceSpecification", price: "0", description: "Custom pricing — contact sales" } },
      ],
      featureList: [
        "Freeform company creation",
        "9 composable primitives",
        "Spend approval gates",
        "Full audit log",
        "Memory lifecycle (candidate → approved → deprecated)",
        "Risk stops (cost anomaly, loop detection, brand violation, spam)",
        "BYOK Anthropic / OpenAI / Google / Mistral / Groq / OpenRouter",
        "HMAC-signed webhooks",
        "Stripe usage-based billing",
        "KVKK + GDPR compliant",
      ],
    },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning data-scroll-behavior="smooth">
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
        <ToastProvider>
          <AuthLayout>
            {children}
          </AuthLayout>
          {/* KVKK/GDPR cookie consent — self-renders only when not yet decided */}
          <CookieConsent />
        </ToastProvider>
      </body>
    </html>
  );
}

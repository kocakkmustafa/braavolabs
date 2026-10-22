import type { Metadata } from "next";
import { headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import AuthLayout from "./AuthLayout";
import CookieConsent from "../components/CookieConsent";
import OptionalAnalytics from "../components/OptionalAnalytics";
import ThemeProvider from "../components/ThemeProvider";
import ThemeSelector from "../components/ThemeSelector";
import LanguageSwitcher from "../components/LanguageSwitcher";
import { THEME_INIT_SCRIPT } from "../lib/theme-preference";
import SkipLink from "../components/SkipLink";
import { ToastProvider } from "../components/Toast";
import { APEX_HOST, PUBLIC_HOST, normalizeSurfaceHost, parseSelfHostedSurfaceHosts, surfaceForHost } from "../lib/surface-domain";
import "./globals.css";

const PUBLIC_ORIGIN = "https://www.braavolabs.com";
const AUTHENTICATED_ORIGIN = "https://app.braavolabs.com";

export async function generateMetadata(): Promise<Metadata> {
  const copy = await getTranslations("publicPreview");
  const requestHeaders = await headers();
  const surface = requestHeaders.get("x-braavolabs-surface") || surfaceForHost(requestHeaders.get("host"));
  const pathname = requestHeaders.get("x-braavolabs-pathname") || "/";
  const origin = surface === "public" ? PUBLIC_ORIGIN : AUTHENTICATED_ORIGIN;
  const canonical = pathname === "/" ? origin : `${origin}${pathname}`;

  return {
    title: {
      default: `${copy("homeTitle")} — Braavolabs`,
      template: "%s | Braavolabs",
    },
    description: copy("homeIntro"),
    keywords: ["Braavolabs", "AI workbench", "AI control plane", "BYOK", "local models"],
    authors: [{ name: "Braavolabs" }],
    metadataBase: new URL(origin),
    alternates: { canonical },
    openGraph: {
      title: `${copy("homeTitle")} — Braavolabs`,
      description: copy("homeIntro"),
      type: "website",
      siteName: "Braavolabs",
      url: canonical,
      images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
    },
    twitter: {
      card: "summary_large_image",
      title: `${copy("homeTitle")} — Braavolabs`,
      description: copy("inferenceFunding"),
      images: ["/og-image.png"],
    },
    verification: {
      google: process.env.GOOGLE_SITE_VERIFICATION || undefined,
      yandex: process.env.YANDEX_VERIFICATION || undefined,
      other: process.env.BING_SITE_VERIFICATION
        ? { "msvalidate.01": process.env.BING_SITE_VERIFICATION }
        : undefined,
    },
  };
}

const SCHEMA_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${PUBLIC_ORIGIN}/#organization`,
      name: "Braavolabs",
      url: PUBLIC_ORIGIN,
      logo: `${PUBLIC_ORIGIN}/braavolabs-logo.png`,
      foundingDate: "2026",
      contactPoint: {
        "@type": "ContactPoint",
        contactType: "customer support",
        email: "support@yulalab.com",
      },
    },
    {
      "@type": "WebSite",
      "@id": `${PUBLIC_ORIGIN}/#website`,
      url: PUBLIC_ORIGIN,
      name: "Braavolabs",
      description: "A cross-vendor AI workbench and control plane.",
      publisher: { "@id": `${PUBLIC_ORIGIN}/#organization` },
      inLanguage: "en",
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${PUBLIC_ORIGIN}/#software`,
      name: "Braavolabs",
      applicationCategory: "DeveloperApplication",
      applicationSubCategory: "Cross-vendor AI workbench and control plane",
      operatingSystem: "macOS, Windows",
      url: PUBLIC_ORIGIN,
      description:
        "Inference is not included. Use your own provider keys (BYOK) or local models.",
      featureList: [
        "Pricing preview — not currently purchasable",
        "Planned pricing: Individual $19/month; Team $39/active-user/month; not currently purchasable",
        "Private Mode — preview; its complete data-handling and security contract remains in development.",
        "Cloud Agent Mode — in development; its execution, consent, and retention contract is not presented as generally available.",
        "Holding — premium/private preview",
        "Signed evidence — in development",
      ],
    },
  ],
};

type IntlMessages = Awaited<ReturnType<typeof getMessages>>;
type MessageRecord = Record<string, unknown>;

function record(value: unknown): MessageRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as MessageRecord)
    : {};
}

function publicMessagesForPath(messages: IntlMessages, pathname: string): IntlMessages {
  const staticMessages = record(record(messages).static);
  const selected: MessageRecord = { common: staticMessages.common, cookieConsent: staticMessages.cookieConsent, appearance: staticMessages.appearance };
  // The public shell's client-side locale selector needs only these labels.
  const language = record(record(messages).language);
  const uiCopy = record(record(messages).uiCopy);
  const surface = record(record(messages).surface);
  const runtime = record(record(messages).runtime);

  if (pathname.startsWith("/privacy")) {
    selected.legal = { privacy: record(staticMessages.legal).privacy };
  } else if (pathname.startsWith("/terms")) {
    selected.legal = { terms: record(staticMessages.legal).terms };
  } else if (pathname.startsWith("/cookies")) {
    selected.legal = { cookies: record(staticMessages.legal).cookies };
  } else if (pathname.startsWith("/gdpr") || pathname.startsWith("/kvkk")) {
    selected.singleLocale = staticMessages.singleLocale;
  } else if (pathname.startsWith("/status")) {
    selected.status = staticMessages.status;
  } else if (pathname.startsWith("/contact")) {
    selected.contact = staticMessages.contact;
  } else if (pathname.startsWith("/about")) {
    selected.about = staticMessages.about;
  } else if (pathname.startsWith("/changelog")) {
    selected.changelog = staticMessages.changelog;
  }

  if (pathname === "/contact") {
    const nav = record(record(messages).nav);
    const fields = record(record(record(messages).auth).fields);
    selected.changelog = { title: record(staticMessages.changelog).title };
    return {
      static: selected,
      uiCopy,
      surface,
      runtime,
      language,
      nav: { features: nav.features, pricing: nav.pricing, signIn: nav.signIn, dashboard: nav.dashboard },
      auth: { fields: { fullName: fields.fullName, fullNamePlaceholder: fields.fullNamePlaceholder, email: fields.email, emailPlaceholder: fields.emailPlaceholder } },
      footer: record(record(messages).footer),
    } as IntlMessages;
  }

  if (pathname === "/terms" || pathname === "/legal/account-deletion") {
    const nav = record(record(messages).nav);
    selected.changelog = { title: record(staticMessages.changelog).title };
    selected.contact = { title: record(staticMessages.contact).title };
    return { static: selected, language, uiCopy, surface, runtime, nav: { features: nav.features, pricing: nav.pricing, signIn: nav.signIn } } as IntlMessages;
  }

  // Client pages with the shared public nav/footer (lib/public-nav-labels) need
  // only these labels; keep the per-path payload minimal.
  const publicNavLabels = () => {
    const nav = record(record(messages).nav);
    const footer = record(record(messages).footer);
    const links = record(record(record(messages).publicPreview).links);
    selected.changelog = { title: record(staticMessages.changelog).title };
    selected.contact = { title: record(staticMessages.contact).title };
    return {
      nav: { features: nav.features, pricing: nav.pricing, integrations: nav.integrations },
      publicPreview: { links: { status: links.status } },
      footer: { privacy: footer.privacy, terms: footer.terms },
    };
  };

  return {
    static: selected, language, uiCopy, surface, runtime,
    ...(pathname === "/blog" ? { content: record(record(messages).content) } : {}),
    ...(pathname === "/blog" || pathname === "/status" ? publicNavLabels() : {}),
  } as IntlMessages;
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const locale = await getLocale();
  const messages = await getMessages();
  const publicCopy = await getTranslations("publicPreview");
  const localizedSchema = { ...SCHEMA_LD, "@graph": SCHEMA_LD["@graph"].map(entry => entry["@type"] === "WebSite" ? { ...entry, description: publicCopy("homeIntro"), inLanguage: locale } : entry["@type"] === "SoftwareApplication" ? { ...entry, applicationSubCategory: publicCopy("homeTitle"), description: publicCopy("inferenceFunding"), featureList: [publicCopy("pricingBadge"), publicCopy("privateMode"), publicCopy("privateModeCopy"), publicCopy("cloudMode"), publicCopy("cloudModeCopy"), publicCopy("holding"), publicCopy("signedEvidence")] } : entry) };
  const requestSurface =
    requestHeaders.get("x-braavolabs-surface") || surfaceForHost(requestHeaders.get("host"));
  const isPublic = requestSurface === "public";
  const host = normalizeSurfaceHost(requestHeaders.get("host"));
  const selfHostedHosts = parseSelfHostedSurfaceHosts(process.env.SELF_HOSTED_SURFACE_HOSTS);
  // A self-hosted document can navigate between public and private routes
  // without discarding vendor listeners. Hold analytics on those hosts.
  const analyticsDomain = isPublic && !selfHostedHosts.has(host) && (host === PUBLIC_HOST || host === APEX_HOST)
    ? process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN
    : undefined;
  const pathname = requestHeaders.get("x-braavolabs-pathname") || "/";
  const providerMessages = isPublic ? publicMessagesForPath(messages, pathname) : messages;
  const content = isPublic ? children : <AuthLayout>{children}</AuthLayout>;

  return (
    <html
      lang={locale}
      dir={locale === "ar" ? "rtl" : "ltr"}
      className="dark"
      suppressHydrationWarning
      data-scroll-behavior="smooth"
    >
      <head>
        <script id="braavo-theme-init" dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Inter:wght@300;400;500;600;700&family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap"
        />
        {isPublic && (
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: JSON.stringify(localizedSchema).replace(/</g, "\\u003c") }}
          />
        )}
      </head>
      <body className="bg-background text-on-surface antialiased">
        <NextIntlClientProvider locale={locale} messages={providerMessages}>
          <ThemeProvider>
          <SkipLink />
          <ToastProvider>
            {content}
            <CookieConsent />
            {analyticsDomain && (
              <OptionalAnalytics domain={analyticsDomain} />
            )}
          </ToastProvider>
          <footer className="bv-appearance-bar"><LanguageSwitcher /><ThemeSelector /></footer>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

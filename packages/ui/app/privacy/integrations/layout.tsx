import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("static.legal.integrations");
  const title = t("title");
  return {
    title,
    description: "How Braavolabs handles personal data in its Chrome extension, GitHub App, Slack App, CLI, outbound email and AI voice calls.",
    robots: { index: true, follow: true },
    alternates: { canonical: "https://www.braavolabs.com/privacy/integrations" },
    openGraph: {
      title,
      description: "How Braavolabs handles personal data in its Chrome extension, GitHub App, Slack App, CLI, outbound email and AI voice calls.",
      url: "https://www.braavolabs.com/privacy/integrations",
      images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
    },
  };
}

export default function PrivacyIntegrationsLayout({ children }: { children: React.ReactNode }) {
  return children;
}

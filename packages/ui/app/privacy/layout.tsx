import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("static.legal.privacy");
  const title = t("title");
  return {
    title,
    description: "The published Braavolabs privacy policy and its current data-handling disclosures.",
    robots: { index: true, follow: true },
    alternates: { canonical: "https://www.braavolabs.com/privacy" },
    openGraph: {
      title,
      description: "The published Braavolabs privacy policy and its current data-handling disclosures.",
      url: "https://www.braavolabs.com/privacy",
      images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
    },
  };
}

export default function PrivacyLayout({ children }: { children: React.ReactNode }) {
  return children;
}

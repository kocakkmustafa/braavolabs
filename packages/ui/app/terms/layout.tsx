import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("static.legal.terms");
  const title = t("title");
  return {
    title,
    description:
      "Braavolabs Terms of Service. Acceptable use, planned subscriptions, cancellation, intellectual property, and limitation of liability.",
    robots: { index: true, follow: true },
    alternates: { canonical: "https://www.braavolabs.com/terms" },
    openGraph: {
      title,
      description:
        "Acceptable use, planned subscriptions, cancellation, intellectual property, and limitation of liability.",
      url: "https://www.braavolabs.com/terms",
      images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
    },
  };
}

export default function TermsLayout({ children }: { children: React.ReactNode }) {
  return children;
}

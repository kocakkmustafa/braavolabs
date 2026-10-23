import { getTranslations as getSeoTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { brandTitle } from "../../lib/brand-title";

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSeoTranslations("seo");
  return {
  title: brandTitle(seo("md6e50ceecc93")),
  description:
    seo("m907e61f93ecc"),
  alternates: { canonical: "https://www.braavolabs.com/pricing" },
  openGraph: {
    title: seo("md6e50ceecc93"),
    description:
      seo("m907e61f93ecc"),
    url: "https://www.braavolabs.com/pricing",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
  twitter: {
    card: "summary_large_image",
    title: seo("md6e50ceecc93"),
    description:
      seo("m907e61f93ecc"),
    images: ["/og-image.png"],
  },
};
}

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return children;
}

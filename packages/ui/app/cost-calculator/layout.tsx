import { getTranslations as getSeoTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { brandTitle } from "../../lib/brand-title";

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSeoTranslations("seo");
  return {
  title: brandTitle(seo("m18c6bf133be5")),
  description: seo("md250d02e7765"),
  alternates: { canonical: "https://www.braavolabs.com/cost-calculator" },
  openGraph: {
    title: seo("m18c6bf133be5"),
    description: seo("m63664d2ded81"),
    url: "https://www.braavolabs.com/cost-calculator",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};
}

export default function CostCalculatorLayout({ children }: { children: React.ReactNode }) {
  return children;
}

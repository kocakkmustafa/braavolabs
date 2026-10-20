import { getTranslations as getSeoTranslations } from "next-intl/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSeoTranslations("seo");
  return {
  title: seo("m57cd5295b6d6"),
  description: seo("m0d5ddd021521"),
  alternates: { canonical: "https://www.braavolabs.com/features" },
  openGraph: {
    title: seo("m57cd5295b6d6"),
    description: seo("m076ced19e485"),
    url: "https://www.braavolabs.com/features",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};
}

export default function FeaturesLayout({ children }: { children: React.ReactNode }) {
  return children;
}

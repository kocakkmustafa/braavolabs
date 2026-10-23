import { getTranslations as getSeoTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { brandTitle } from "../../lib/brand-title";

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSeoTranslations("seo");
  return {
  title: brandTitle(seo("mc10f93cbb285")),
  description: seo("mac714bedbfdc"),
  alternates: { canonical: "https://www.braavolabs.com/contact" },
  openGraph: {
    title: seo("m5d4c651fc9a1"),
    description: seo("m224950150646"),
    url: "https://www.braavolabs.com/contact",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

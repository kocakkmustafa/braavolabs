import { getTranslations as getSeoTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { brandTitle } from "../../../lib/brand-title";

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSeoTranslations("seo");
  return {
  title: brandTitle(seo("mc60388ffa286")),
  description:
    seo("m265910871d03"),
  alternates: { canonical: "https://www.braavolabs.com/legal/account-deletion" },
  openGraph: {
    title: seo("m7221097dfb51"),
    description:
      seo("m265910871d03"),
    url: "https://www.braavolabs.com/legal/account-deletion",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

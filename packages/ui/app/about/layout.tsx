import { getTranslations as getSeoTranslations } from "next-intl/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSeoTranslations("seo");
  return {
  title: seo("m7f135831dde4"),
  description:
    seo("ma6b9aebb2cf1"),
  alternates: { canonical: "https://www.braavolabs.com/about" },
  openGraph: {
    title: seo("m933085a63c1d"),
    description:
      seo("me1c1f91ee66e"),
    url: "https://www.braavolabs.com/about",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

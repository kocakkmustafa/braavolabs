import { getTranslations as getSeoTranslations } from "next-intl/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSeoTranslations("seo");
  return {
  title: seo("m22ccccca604b"),
  description: seo("m545df19cd499"),
  alternates: { canonical: "https://www.braavolabs.com/status" },
  openGraph: {
    title: seo("m5231bbf800e5"),
    description: seo("m545df19cd499"),
    url: "https://www.braavolabs.com/status",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

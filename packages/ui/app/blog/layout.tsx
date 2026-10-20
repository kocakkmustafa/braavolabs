import { getTranslations as getSeoTranslations } from "next-intl/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSeoTranslations("seo");
  return {
  title: seo("md93cc7f7d87e"),
  description: seo("m187c2f0813ea"),
  alternates: { canonical: "https://www.braavolabs.com/blog" },
  openGraph: {
    title: seo("m3c43895bb6aa"),
    description: seo("me3020c8ef693"),
    url: "https://www.braavolabs.com/blog",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

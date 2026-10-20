import { getTranslations as getSeoTranslations } from "next-intl/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSeoTranslations("seo");
  return {
  title: seo("m237cecbe666d"),
  description: seo("m22bcd4a9abed"),
  alternates: { canonical: "https://www.braavolabs.com/changelog" },
  openGraph: {
    title: seo("m7cf63d5b37a7"),
    description: seo("m9b27dd7fb727"),
    url: "https://www.braavolabs.com/changelog",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

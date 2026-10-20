import { getTranslations as getSeoTranslations } from "next-intl/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSeoTranslations("seo");
  return {
  title: seo("mac377e08a5eb"),
  description:
    seo("m49fe3634c177"),
  alternates: { canonical: "https://www.braavolabs.com/gdpr" },
  openGraph: {
    title: seo("m617c9c8f521f"),
    description:
      seo("m5f3c445d83bb"),
    url: "https://www.braavolabs.com/gdpr",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

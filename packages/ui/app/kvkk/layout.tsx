import { getTranslations as getSeoTranslations } from "next-intl/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSeoTranslations("seo");
  return {
  title: seo("m6481ac9863e9"),
  description:
    seo("m6465a09ee4b0"),
  alternates: { canonical: "https://www.braavolabs.com/kvkk" },
  openGraph: {
    title: seo("m4a89104ba3fb"),
    description:
      seo("m354a5e2b9623"),
    url: "https://www.braavolabs.com/kvkk",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

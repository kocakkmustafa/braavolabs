import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("static.legal.cookies");
  const title = t("title");
  return {
    title,
    description:
      "Braavolabs cookie policy: what cookies we use, why we use them, and how to manage or withdraw your consent at any time.",
    alternates: { canonical: "https://www.braavolabs.com/cookies" },
    openGraph: {
      title,
      description:
        "What cookies Braavolabs uses, why, and how to manage or withdraw your consent at any time.",
      url: "https://www.braavolabs.com/cookies",
      images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
    },
  };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

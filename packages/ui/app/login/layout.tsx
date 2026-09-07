import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.login");
  return {
    title: t("tabSignIn"),
    description: t("subtitle"),
    // Auth pages should not be indexed.
    robots: { index: false, follow: false },
  };
}

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}

import { getTranslations as getSeoTranslations } from "next-intl/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSeoTranslations("seo");
  return {
  title: seo("mae42d1776ea3"),
  description: seo("m81bf5e60c133"),
  robots: { index: false, follow: false },
};
}

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}

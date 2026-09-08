"use client";

import { useTranslations } from "next-intl";

export default function SkipLink() {
  const t = useTranslations("static.common");
  return <a href="#main-content" className="skip-link">{t("skipToMainContent")}</a>;
}

/** Message keys for the fixed public navigation labels (all 14 locales carry them). */
export const PUBLIC_NAV_LABEL_KEYS = {
  Features: "nav.features",
  Pricing: "nav.pricing",
  Integrations: "nav.integrations",
  Changelog: "static.changelog.title",
  Blog: "static.common.legalPage.blog",
  About: "static.common.legalPage.about",
  Contact: "static.contact.title",
  Status: "publicPreview.links.status",
  Privacy: "footer.privacy",
  Terms: "footer.terms",
} as const;
export type PublicNavLabel = keyof typeof PUBLIC_NAV_LABEL_KEYS;

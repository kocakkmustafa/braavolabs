import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — Braavolabs",
  description:
    "How Braavolabs collects, uses, and protects your data. Tenant-isolated storage, no training on your data, AES-256 encrypted credentials, GDPR + CCPA aligned.",
  robots: { index: true, follow: true },
  alternates: { canonical: "https://www.braavolabs.com/privacy" },
  openGraph: {
    title: "Braavolabs Privacy Policy",
    description:
      "Tenant-isolated storage, no training on your data, AES-256 encrypted credentials, GDPR + CCPA aligned.",
    url: "https://www.braavolabs.com/privacy",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function PrivacyLayout({ children }: { children: React.ReactNode }) {
  return children;
}

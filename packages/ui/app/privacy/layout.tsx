import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — Braavolabs",
  description: "The published Braavolabs privacy policy and its current data-handling disclosures.",
  robots: { index: true, follow: true },
  alternates: { canonical: "https://www.braavolabs.com/privacy" },
  openGraph: {
    title: "Braavolabs Privacy Policy",
    description: "The published Braavolabs privacy policy and its current data-handling disclosures.",
    url: "https://www.braavolabs.com/privacy",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function PrivacyLayout({ children }: { children: React.ReactNode }) {
  return children;
}

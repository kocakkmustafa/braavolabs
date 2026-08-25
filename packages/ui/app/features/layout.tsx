import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Features — Braavolabs",
  description: "Braavolabs public product boundaries across model routing, data modes, approvals, and feature maturity.",
  alternates: { canonical: "https://www.braavolabs.com/features" },
  openGraph: {
    title: "Features — Braavolabs",
    description: "Public product boundaries across model routing, data modes, approvals, and feature maturity.",
    url: "https://www.braavolabs.com/features",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function FeaturesLayout({ children }: { children: React.ReactNode }) {
  return children;
}

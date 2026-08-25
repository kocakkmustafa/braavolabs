import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service — Braavolabs",
  description:
    "Braavolabs Terms of Service. Acceptable use, planned subscriptions, cancellation, intellectual property, and limitation of liability.",
  robots: { index: true, follow: true },
  alternates: { canonical: "https://www.braavolabs.com/terms" },
  openGraph: {
    title: "Braavolabs Terms of Service",
    description:
      "Acceptable use, planned subscriptions, cancellation, intellectual property, and limitation of liability.",
    url: "https://www.braavolabs.com/terms",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function TermsLayout({ children }: { children: React.ReactNode }) {
  return children;
}

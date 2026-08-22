import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Contact — Braavolabs",
  description:
    "Reach the Braavolabs team for sales, technical support, partnerships, security, and privacy inquiries. We typically reply within one business day.",
  alternates: { canonical: "https://www.braavolabs.com/contact" },
  openGraph: {
    title: "Contact Braavolabs",
    description:
      "Sales, technical support, partnerships, security, and privacy inquiries. Usually reply within one business day.",
    url: "https://www.braavolabs.com/contact",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Contact — Braavolabs",
  description: "Braavolabs contact routes for support, partnerships, security, and privacy inquiries.",
  alternates: { canonical: "https://www.braavolabs.com/contact" },
  openGraph: {
    title: "Contact Braavolabs",
    description: "Contact routes for support, partnerships, security, and privacy inquiries.",
    url: "https://www.braavolabs.com/contact",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

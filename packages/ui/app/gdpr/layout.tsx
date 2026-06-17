import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "GDPR Statement — Braavolabs",
  description:
    "Braavolabs GDPR statement: data controller identity, lawful bases, cross-border transfers, retention periods, and your rights under EU data protection law.",
  alternates: { canonical: "https://braavolabs.com/gdpr" },
  openGraph: {
    title: "Braavolabs GDPR Statement",
    description:
      "Data controller, lawful bases, cross-border transfers, retention, and your rights under the EU General Data Protection Regulation.",
    url: "https://braavolabs.com/gdpr",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

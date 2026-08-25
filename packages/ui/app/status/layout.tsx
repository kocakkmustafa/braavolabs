import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "System Status — Braavolabs",
  description: "A live availability probe for the public Braavolabs API endpoint.",
  alternates: { canonical: "https://www.braavolabs.com/status" },
  openGraph: {
    title: "Braavolabs System Status",
    description: "A live availability probe for the public Braavolabs API endpoint.",
    url: "https://www.braavolabs.com/status",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

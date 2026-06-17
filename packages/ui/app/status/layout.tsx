import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "System Status — Braavolabs",
  description:
    "Live status of Braavolabs services: API availability, pipeline worker, webhook delivery, authentication, and billing — with incident history.",
  alternates: { canonical: "https://braavolabs.com/status" },
  openGraph: {
    title: "Braavolabs System Status",
    description:
      "Live status of the Braavolabs API, pipeline worker, webhook delivery, authentication, and billing.",
    url: "https://braavolabs.com/status",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

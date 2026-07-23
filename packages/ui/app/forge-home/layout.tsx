import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Braavolabs — Every agent needs a gate",
  description:
    "A four-act scrollytelling tour of Braavolabs: governed agents, a multi-model council, an auditable ledger, and a desktop app that runs on your own machine.",
  alternates: { canonical: "https://braavolabs.com/forge-home" },
  openGraph: {
    title: "Braavolabs — Every agent needs a gate",
    description: "Governed agents, a multi-model council, an auditable ledger, and a desktop app that runs on your machine.",
    url: "https://braavolabs.com/forge-home",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
  // Prototype route (same posture as /forge) — keep it out of search results
  // / crawl budget until it's reviewed and actually linked-to.
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

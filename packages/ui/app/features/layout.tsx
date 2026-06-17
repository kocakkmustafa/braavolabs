import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Features — Braavolabs",
  description:
    "Autonomous AI agents, 9 composable primitives, multi-step pipelines, memory engine, governance, spend approval gates, AI Agent Composer, and real-time run streaming.",
  alternates: { canonical: "https://braavolabs.com/features" },
  openGraph: {
    title: "Features — Braavolabs",
    description:
      "Autonomous AI agents · 9 Primitives · Pipeline engine · Memory engine · Governance · Spend approval · AI Agent Composer.",
    url: "https://braavolabs.com/features",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function FeaturesLayout({ children }: { children: React.ReactNode }) {
  return children;
}

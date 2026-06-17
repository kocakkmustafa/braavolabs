import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Cost Calculator — Braavolabs",
  description:
    "Compare Braavolabs flat pricing against per-task automation billing. Slide your run volume and steps to see the cost difference — BYOK spend, no fabricated competitor figures.",
  alternates: { canonical: "https://braavolabs.com/cost-calculator" },
  openGraph: {
    title: "Cost Calculator — Braavolabs",
    description:
      "Flat plan + your own BYOK keys vs. per-task metering. Interactive calculator with all competitor figures clearly labelled illustrative.",
    url: "https://braavolabs.com/cost-calculator",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function CostCalculatorLayout({ children }: { children: React.ReactNode }) {
  return children;
}

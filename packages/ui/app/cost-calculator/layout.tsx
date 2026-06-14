import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Cost calculator",
  description:
    "Compare Braavolabs' flat, predictable pricing (plus your own BYOK model spend) against per-task automation billing. Slide your run volume and steps to see which cost stays still — predictability, not a fabricated competitor quote.",
  openGraph: {
    title: "Cost calculator — Braavolabs",
    description:
      "Flat plan + your own BYOK keys vs. per-task metering that scales with every step. Interactive, with all competitor figures clearly labelled illustrative.",
  },
};

export default function CostCalculatorLayout({ children }: { children: React.ReactNode }) {
  return children;
}

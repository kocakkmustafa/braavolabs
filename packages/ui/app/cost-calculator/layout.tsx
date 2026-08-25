import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Cost Calculator — Braavolabs",
  description: "A static preview of planned Individual and Team subscription pricing; inference is not included.",
  alternates: { canonical: "https://www.braavolabs.com/cost-calculator" },
  openGraph: {
    title: "Cost Calculator — Braavolabs",
    description: "Planned Individual and Team pricing preview; subscriptions are not currently purchasable.",
    url: "https://www.braavolabs.com/cost-calculator",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function CostCalculatorLayout({ children }: { children: React.ReactNode }) {
  return children;
}

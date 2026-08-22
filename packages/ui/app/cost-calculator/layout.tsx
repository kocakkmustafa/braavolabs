import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Cost Calculator — Braavolabs",
  description:
    "Estimate the monthly Braavolabs subscription for Individual or Team active users. Inference, taxes, hardware, and external-service costs are excluded.",
  alternates: { canonical: "https://www.braavolabs.com/cost-calculator" },
  openGraph: {
    title: "Cost Calculator — Braavolabs",
    description:
      "Estimate an Individual or Team monthly subscription. Inference, taxes, hardware, and external-service costs are outside the estimate.",
    url: "https://www.braavolabs.com/cost-calculator",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function CostCalculatorLayout({ children }: { children: React.ReactNode }) {
  return children;
}

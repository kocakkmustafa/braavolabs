import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Simple, transparent pricing. Free plan with 1 AI company + 10 runs/month — no card. Creator $19, Pro $39, Business $99. 20% off on annual billing.",
  openGraph: {
    title: "Pricing — Braavolabs",
    description:
      "Free plan with 1 AI company + 10 runs/month, no card required. Creator $19, Pro $39, Business $99. 20% off annual.",
  },
};

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return children;
}

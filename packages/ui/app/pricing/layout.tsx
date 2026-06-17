import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing — Braavolabs",
  description:
    "Simple, transparent pricing. Free plan with 1 AI company + 10 runs/month — no card. Creator $19, Pro $39, Business $99. 20% off on annual billing.",
  alternates: { canonical: "https://braavolabs.com/pricing" },
  openGraph: {
    title: "Pricing — Braavolabs",
    description:
      "Free plan with 1 AI company + 10 runs/month, no card required. Creator $19, Pro $39, Business $99. 20% off annual.",
    url: "https://braavolabs.com/pricing",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return children;
}

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing — Braavolabs",
  description:
    "Individual is $19/month. Team is $39/active-user/month. Inference is not included; use provider keys or local models.",
  alternates: { canonical: "https://www.braavolabs.com/pricing" },
  openGraph: {
    title: "Pricing — Braavolabs",
    description:
      "Individual — $19/month. Team — $39/active-user/month. Inference is not included.",
    url: "https://www.braavolabs.com/pricing",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return children;
}

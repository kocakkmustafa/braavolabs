import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing — Braavolabs",
  description:
    "Planned pricing preview: Individual $19/month and Team $39/active-user/month. Not currently purchasable; inference is not included.",
  alternates: { canonical: "https://www.braavolabs.com/pricing" },
  openGraph: {
    title: "Pricing — Braavolabs",
    description:
      "Planned pricing preview: Individual $19/month and Team $39/active-user/month. Not currently purchasable; inference is not included.",
    url: "https://www.braavolabs.com/pricing",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Pricing — Braavolabs",
    description:
      "Planned pricing preview: Individual $19/month and Team $39/active-user/month. Not currently purchasable; inference is not included.",
    images: ["/og-image.png"],
  },
};

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return children;
}

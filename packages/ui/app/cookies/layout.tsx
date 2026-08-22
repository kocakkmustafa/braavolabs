import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Cookie Policy — Braavolabs",
  description:
    "Braavolabs cookie policy: what cookies we use, why we use them, and how to manage or withdraw your consent at any time.",
  alternates: { canonical: "https://www.braavolabs.com/cookies" },
  openGraph: {
    title: "Braavolabs Cookie Policy",
    description:
      "What cookies Braavolabs uses, why, and how to manage or withdraw your consent at any time.",
    url: "https://www.braavolabs.com/cookies",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

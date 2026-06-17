import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Blog — Braavolabs",
  description:
    "Product updates, engineering deep-dives, and field notes on building autonomous AI companies — from the Braavolabs team.",
  alternates: { canonical: "https://braavolabs.com/blog" },
  openGraph: {
    title: "Braavolabs Blog",
    description:
      "Product updates, engineering deep-dives, and field notes on building autonomous AI companies.",
    url: "https://braavolabs.com/blog",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

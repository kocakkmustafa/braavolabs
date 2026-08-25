import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About — Braavolabs",
  description:
    "Learn about Braavolabs: why we built an AI company platform, the principles behind it, and how we think about autonomy, transparency, and responsible AI.",
  alternates: { canonical: "https://www.braavolabs.com/about" },
  openGraph: {
    title: "About Braavolabs",
    description:
      "Why we built an AI company platform, the principles behind it, and how we think about autonomy, transparency, and responsible AI.",
    url: "https://www.braavolabs.com/about",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

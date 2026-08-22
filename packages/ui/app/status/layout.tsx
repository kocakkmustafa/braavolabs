import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "System Status — Braavolabs",
  description:
    "A live browser probe of the Braavolabs public API health endpoint, plus confirmation that the public status page is being served.",
  alternates: { canonical: "https://www.braavolabs.com/status" },
  openGraph: {
    title: "Braavolabs System Status",
    description:
      "A live browser probe of the public API health endpoint and confirmation that this status page is being served.",
    url: "https://www.braavolabs.com/status",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Changelog — Braavolabs",
  description:
    "Release history for Braavolabs: new features, fixes, and changes — from BYOK routing and mobile control to mid-run steering and offline mode.",
  alternates: { canonical: "https://braavolabs.com/changelog" },
  openGraph: {
    title: "Braavolabs Changelog",
    description:
      "New features, fixes, and changes — from BYOK routing and mobile control to mid-run steering and offline mode.",
    url: "https://braavolabs.com/changelog",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

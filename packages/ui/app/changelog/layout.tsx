import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Changelog — Braavolabs",
  description: "Public Braavolabs change notes with shipped and in-development work labelled separately.",
  alternates: { canonical: "https://www.braavolabs.com/changelog" },
  openGraph: {
    title: "Braavolabs Changelog",
    description: "Public change notes with shipped and in-development work labelled separately.",
    url: "https://www.braavolabs.com/changelog",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Braavolabs — Ai Dohaeris",
  description:
    "Braavolabs: binlerce ajan, tek bir çatı altında. Niyetini söyle, gerisini biz hallederiz.",
  alternates: { canonical: "https://braavolabs.com/forge" },
  openGraph: {
    title: "Braavolabs — Ai Dohaeris",
    description: "Binlerce ajan, tek bir çatı altında. Niyetini söyle, gerisini biz hallederiz.",
    url: "https://braavolabs.com/forge",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
  // Prototype route — keep it out of search results / crawl budget until
  // it's a real, linked-to page.
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

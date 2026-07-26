import type { Metadata } from "next";
import ForgeHomeScroll from "./_home/ForgeHomeScroll";

/**
 * The site homepage.
 *
 * HISTORY: this page was built at `/forge-home` on 2026-07-25 as a `noindex`
 * prototype route deliberately linked from nowhere, while `/` kept serving the
 * 2026-06-14 landing page. That left the finished work invisible: the deploy
 * was green, the URL worked, and every visitor still saw the old site. The
 * promotion happens here — the prototype IS the homepage now, so the robots
 * block that hid it is gone and the canonical points at the root.
 *
 * The old landing's pricing table is NOT lost: `/pricing` already carries the
 * same four plans at the same prices, is localized in all six locales, and is
 * what the other 22 internal pricing links already pointed at.
 *
 * This file is a SERVER component on purpose — it lets the homepage own its
 * own metadata (the page itself is a client component full of scroll/GSAP
 * state, and a client component cannot export `metadata`).
 */
export const metadata: Metadata = {
  title: "Braavolabs — Every agent needs a gate",
  description:
    "Governed agents, a multi-model council, an auditable ledger, and a desktop app that runs on your own machine. Every risky step passes an approval gate.",
  alternates: { canonical: "https://braavolabs.com" },
  openGraph: {
    title: "Braavolabs — Every agent needs a gate",
    description:
      "Governed agents, a multi-model council, an auditable ledger, and a desktop app that runs on your machine.",
    url: "https://braavolabs.com",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function HomePage() {
  return <ForgeHomeScroll />;
}

import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// Self-hosted via next/font (build-time, CSP-safe — no CDN request) so the
// dashboard's mono numbers/labels actually render in JetBrains Mono instead
// of silently falling back to system ui-monospace. Mirrors the same face
// already loaded for /forge (see app/forge/ForgeHero.tsx) but scoped to
// this route only via the --dash-font-mono variable, consumed by
// dashboard.module.css's `.dashShell { --bv-font-mono: var(--dash-font-mono), ...; }`
// override. Only exposes the CSS variable (no `.className`), so it doesn't
// force mono onto anything by default — every other route is unaffected.
const monoFont = JetBrains_Mono({ subsets: ["latin"], variable: "--dash-font-mono", display: "swap" });

export default function Layout({ children }: { children: React.ReactNode }) {
  return <div className={monoFont.variable}>{children}</div>;
}


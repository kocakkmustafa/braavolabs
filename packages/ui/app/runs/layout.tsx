import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// Self-hosted via next/font (build-time, CSP-safe — no CDN request) so the
// Forge restyle's mono ids/timestamps/spend values actually render in
// JetBrains Mono instead of silently falling back to system ui-monospace.
// Mirrors the same route-scoped pattern as app/dashboard/layout.tsx, scoped
// here via --runs-font-mono and consumed by runs.module.css's
// `.runsShell { --bv-font-mono: var(--runs-font-mono), ...; }` override.
// Only exposes the CSS variable (no `.className`), so it doesn't force
// mono onto anything by default.
const monoFont = JetBrains_Mono({ subsets: ["latin"], variable: "--runs-font-mono", display: "swap" });

export default function Layout({ children }: { children: React.ReactNode }) {
  return <div className={monoFont.variable}>{children}</div>;
}


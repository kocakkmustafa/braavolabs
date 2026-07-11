import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// Self-hosted via next/font (build-time, CSP-safe — no CDN request), same
// route-scoped pattern as app/dashboard/layout.tsx and every other Forge-
// restyled route (drafts, runs, companies, ...): only exposes the
// --ask-font-mono CSS variable, consumed by ask.module.css's
// `.askShell { --bv-font-mono: var(--ask-font-mono), ...; }` override, so
// nothing outside /ask is affected.
const monoFont = JetBrains_Mono({ subsets: ["latin"], variable: "--ask-font-mono", display: "swap" });

export default function Layout({ children }: { children: React.ReactNode }) {
  return <div className={monoFont.variable}>{children}</div>;
}

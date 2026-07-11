import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// Self-hosted via next/font (build-time, CSP-safe — no CDN request) so the
// Forge restyle's mono stat numbers/timestamps/activity-log rows actually
// render in JetBrains Mono instead of silently falling back to system
// ui-monospace. Mirrors the same route-scoped pattern as
// app/dashboard/layout.tsx, scoped here via --risks-font-mono and
// consumed by risks.module.css's
// `.risksShell { --bv-font-mono: var(--risks-font-mono), ...; }`
// override. Only exposes the CSS variable (no `.className`), so it
// doesn't force mono onto anything by default.
//
// This route previously had no layout.tsx at all (unlike its sibling
// routes), so this file is new rather than an edit — it otherwise
// mirrors app/dashboard/layout.tsx, app/approvals/layout.tsx,
// app/analytics/layout.tsx and app/drafts/layout.tsx exactly.
const monoFont = JetBrains_Mono({ subsets: ["latin"], variable: "--risks-font-mono", display: "swap" });

export default function Layout({ children }: { children: React.ReactNode }) {
  return <div className={monoFont.variable}>{children}</div>;
}

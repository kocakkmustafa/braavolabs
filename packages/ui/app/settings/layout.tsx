import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// Self-hosted via next/font (build-time, CSP-safe — no CDN request) so the
// Forge restyle's mono ids/prices/live-preview rows actually render in
// JetBrains Mono instead of silently falling back to system ui-monospace.
// Mirrors the same route-scoped pattern as app/dashboard/layout.tsx, scoped
// here via --settings-font-mono and consumed by settings.module.css's
// `.settingsShell { --bv-font-mono: var(--settings-font-mono), ...; }`
// override. Covers both /settings and /settings/identity (no nested
// layout under identity/, so this one wraps both). Only exposes the CSS
// variable (no `.className`), so it doesn't force mono onto anything by
// default.
const monoFont = JetBrains_Mono({ subsets: ["latin"], variable: "--settings-font-mono", display: "swap" });

export default function Layout({ children }: { children: React.ReactNode }) {
  return <div className={monoFont.variable}>{children}</div>;
}


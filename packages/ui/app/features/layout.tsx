import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Features",
  description:
    "Autonomous agents with tool use, 9 primitive system, multi-step pipelines with cron triggers, memory engine, governance, spend approval, AI Agent Composer, real-time SSE run streaming.",
  openGraph: {
    title: "Features — Braavolabs",
    description:
      "Autonomous AI agents · 9 Primitives · Pipeline engine · Memory engine · Governance · Spend approval · AI Agent Composer.",
  },
};

export default function FeaturesLayout({ children }: { children: React.ReactNode }) {
  return children;
}

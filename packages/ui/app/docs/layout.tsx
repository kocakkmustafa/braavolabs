import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Documentation",
  description:
    "Everything you need to build and run autonomous AI companies — getting started, primitives, agents, pipelines, memory, approvals, integrations, and the export-to-Claude-Code skill bundle.",
  openGraph: {
    title: "Documentation — Braavolabs",
    description: "Build and run autonomous AI companies. Getting started, agents, pipelines, memory, exports.",
  },
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return children;
}

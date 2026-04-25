import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign in",
  description:
    "Sign in to your Braavolabs account or create one. Free plan — 1 AI company, 10 runs/month, real AI output from day one. No card required.",
  // Auth pages should not be indexed.
  robots: { index: false, follow: false },
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}

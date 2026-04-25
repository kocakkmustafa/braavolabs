import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Reset password",
  description: "Set a new password for your Braavolabs account.",
  robots: { index: false, follow: false },
};

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Account Deletion",
  description:
    "How to permanently delete your Braavolabs account, what data is removed, and how to request assistance.",
  alternates: { canonical: "https://www.braavolabs.com/legal/account-deletion" },
  openGraph: {
    title: "Braavolabs Account Deletion",
    description:
      "How to permanently delete your Braavolabs account, what data is removed, and how to request assistance.",
    url: "https://www.braavolabs.com/legal/account-deletion",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

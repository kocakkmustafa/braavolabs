import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How Braavolabs collects, uses, and protects your data. Tenant-isolated storage, no training on your data, AES-256 encrypted credentials, GDPR + CCPA aligned.",
  robots: { index: true, follow: true },
};

export default function PrivacyLayout({ children }: { children: React.ReactNode }) {
  return children;
}

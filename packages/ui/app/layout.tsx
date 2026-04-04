import type { Metadata } from "next";
import "./globals.css";
import AuthLayout from "./AuthLayout";
import { ToastProvider } from "../components/Toast";

export const metadata: Metadata = {
  title: {
    default: "AI Company OS",
    template: "%s | AI Company OS",
  },
  description: "Build and run autonomous AI companies from plain text. 9 AI agents, full audit logs, running 24/7.",
  keywords: ["AI", "autonomous company", "AI agents", "automation", "pipeline", "Claude"],
  authors: [{ name: "AI Company OS" }],
  openGraph: {
    title: "AI Company OS",
    description: "Build and run autonomous AI companies from plain text. 9 AI agents, full audit logs, running 24/7.",
    type: "website",
    siteName: "AI Company OS",
  },
  twitter: {
    card: "summary_large_image",
    title: "AI Company OS",
    description: "Build and run autonomous AI companies from plain text.",
  },
  icons: {
    icon: [
      { url: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0%' stop-color='%2300d1ff'/><stop offset='100%' stop-color='%236d11ad'/></linearGradient></defs><rect width='32' height='32' rx='8' fill='url(%23g)'/><text x='16' y='22' font-size='14' font-weight='bold' text-anchor='middle' fill='white' font-family='sans-serif'>AI</text></svg>", type: "image/svg+xml" },
    ],
  },
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "http://localhost:3001"),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning data-scroll-behavior="smooth">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Preload Material Symbols font CSS to avoid FOIT on first load (BUG-04) */}
        <link rel="preload" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" as="style" />
        <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
        <link rel="preload" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" as="style" />
        <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet" />
      </head>
      <body className="bg-background text-on-surface antialiased">
        <ToastProvider>
          <AuthLayout>
            {children}
          </AuthLayout>
        </ToastProvider>
      </body>
    </html>
  );
}

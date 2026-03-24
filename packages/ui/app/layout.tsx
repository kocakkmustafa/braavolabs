import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Company OS",
  description: "Autonomous AI company creation platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="tr">
      <body className="bg-gray-50 text-gray-900 antialiased">
        <div className="flex h-screen">
          {/* Sidebar */}
          <aside className="w-64 bg-gray-900 text-white flex flex-col">
            <div className="p-4 text-xl font-bold border-b border-gray-700">
              AI Company OS
            </div>
            <nav className="flex-1 p-4 space-y-1">
              <NavLink href="/">Dashboard</NavLink>
              <NavLink href="/onboarding">Get Started</NavLink>
              <NavLink href="/companies">Companies</NavLink>
              <NavLink href="/approvals">Approvals</NavLink>
              <NavLink href="/drafts">Drafts</NavLink>
              <NavLink href="/analytics">Analytics</NavLink>
              <NavLink href="/risks">Risks</NavLink>
              <NavLink href="/settings">Settings</NavLink>
            </nav>
          </aside>

          {/* Main content */}
          <main className="flex-1 overflow-auto p-8">{children}</main>
        </div>
      </body>
    </html>
  );
}

function NavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className="block px-3 py-2 rounded-md text-sm hover:bg-gray-800 transition-colors"
    >
      {children}
    </a>
  );
}

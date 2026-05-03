"use client";

export default function BlogPage() {
  return (
    <div className="min-h-screen" style={{ background: "#0a0d14" }}>
      <nav
        className="flex items-center justify-between px-6 md:px-10 py-5 max-w-[1100px] mx-auto"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
      >
        <a href="/" className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
          >
            <span className="text-white font-bold text-xs">AI</span>
          </div>
          <span className="font-headline font-bold text-sm" style={{ color: "#e1e2eb" }}>Braavolabs</span>
        </a>
        <a href="/" className="text-sm hover:text-white transition-colors" style={{ color: "#859399" }}>← Back</a>
      </nav>

      <div className="max-w-[720px] mx-auto px-6 py-24 text-center">
        <span className="material-symbols-outlined text-5xl mb-6 inline-block" style={{ color: "#00d1ff" }}>edit_note</span>
        <h1 className="font-headline font-extrabold mb-3" style={{ fontSize: "2rem", color: "#e1e2eb" }}>Blog coming soon</h1>
        <p className="text-sm mb-8 mx-auto" style={{ color: "#859399", maxWidth: "420px" }}>
          We&apos;re writing about how we build, what works, and what doesn&apos;t. First posts land soon — until then, follow the build in public on social.
        </p>
        <a
          href="/"
          className="inline-block px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110"
          style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", boxShadow: "0 0 20px rgba(0,209,255,0.2)" }}
        >
          Back to home
        </a>
      </div>
    </div>
  );
}

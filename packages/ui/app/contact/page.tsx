"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

export default function ContactPage() {
  const t = useTranslations();

  // Stable channel keys + matching email addresses; per-locale labels
  // resolve at render time so the row copy translates while emails stay
  // the same.
  const channels = [
    { key: "General", email: "hello@braavolabs.com", icon: "mail" },
    { key: "Support", email: "founders@braavolabs.com", icon: "person" },
    { key: "Sales", email: "sales@braavolabs.com", icon: "handshake" },
    { key: "Privacy", email: "privacy@braavolabs.com", icon: "lock" },
    { key: "Kvkk", email: "kvkk@braavolabs.com", icon: "gavel" },
    { key: "Security", email: "security@braavolabs.com", icon: "shield" },
  ];

  const [submitted, setSubmitted] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", topic: "Sales & pricing", message: "" });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
  }

  return (
    <div className="min-h-screen bv-mesh">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 md:px-10 py-4 max-w-[1200px] mx-auto border-b border-outline-variant/40">
        <a href="/" className="flex items-center gap-2.5">
          <div className="bv-avatar" style={{ width: 32, height: 32, borderRadius: 10, fontSize: 12 }}>
            BL
          </div>
          <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
        </a>
        <div className="hidden md:flex items-center gap-6 text-sm text-on-surface-variant">
          <a href="/features" className="hover:text-on-surface transition-colors">Features</a>
          <a href="/pricing" className="hover:text-on-surface transition-colors">Pricing</a>
          <a href="/changelog" className="hover:text-on-surface transition-colors">Changelog</a>
        </div>
        <div className="flex items-center gap-2">
          <a href="/login" className="bv-btn bv-btn-ghost bv-btn-sm">Sign in</a>
          <a href="/register" className="bv-btn bv-btn-primary bv-btn-sm">Start free</a>
        </div>
      </nav>

      {/* Main two-column layout */}
      <div className="max-w-[1200px] mx-auto px-6 md:px-10 py-14 md:py-20">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_1.1fr] gap-12 md:gap-16 items-center min-h-[calc(100vh-120px)] md:min-h-0">

          {/* Left: emblem + headline + channels */}
          <div className="flex flex-col">
            {/* Emblem with halo */}
            <div className="relative w-[100px] h-[100px] mb-7">
              <div
                className="absolute inset-0 rounded-full animate-pulse-glow"
                style={{
                  background: "radial-gradient(circle, rgba(59,130,246,0.35), transparent 65%)",
                  filter: "blur(12px)",
                  inset: "-14%",
                }}
              />
              <div
                className="bv-avatar absolute inset-0 w-full h-full z-10"
                style={{
                  borderRadius: "50%",
                  fontSize: 32,
                  fontWeight: 700,
                  background: "var(--bv-gradient-brand)",
                  boxShadow: "0 0 22px rgba(59,130,246,0.4)",
                  WebkitMask: "radial-gradient(circle, #000 70%, transparent 80%)",
                  mask: "radial-gradient(circle, #000 70%, transparent 80%)",
                }}
              >
                BL
              </div>
            </div>

            {/* Headline */}
            <h1
              className="font-headline font-semibold uppercase text-on-surface mb-4"
              style={{ fontSize: "clamp(34px, 4.6vw, 52px)", letterSpacing: "-0.02em", lineHeight: 0.98 }}
            >
              Talk to the<br />
              <span className="bv-grad-text">operators.</span>
            </h1>

            <p className="text-on-surface-variant text-sm mb-8 max-w-[42ch] leading-relaxed">
              {t("static.contact.subtitle")}
            </p>

            {/* Channel list */}
            <div className="flex flex-col gap-3 bv-stagger">
              {channels.map((c) => (
                <a
                  key={c.email}
                  href={`mailto:${c.email}`}
                  className="bv-glass flex items-center gap-3.5 px-4 py-3.5 rounded-2xl hover:no-underline group"
                  style={{ borderRadius: 14 }}
                >
                  <div
                    className="flex-none w-9 h-9 rounded-xl flex items-center justify-center text-primary"
                    style={{
                      background: "rgba(59,130,246,0.10)",
                      border: "1px solid rgba(59,130,246,0.18)",
                    }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 17 }}>
                      {c.icon}
                    </span>
                  </div>
                  <div>
                    <div className="bv-micro mb-0.5">{t(`static.contact.channel${c.key}`)}</div>
                    <div className="text-sm text-on-surface group-hover:text-primary transition-colors">{c.email}</div>
                  </div>
                </a>
              ))}
            </div>
          </div>

          {/* Right: contact form */}
          <div className="bv-glass p-8 md:p-10" style={{ borderRadius: 20 }}>
            {!submitted ? (
              <form onSubmit={handleSubmit} className="flex flex-col gap-5">
                <div>
                  <h2 className="bv-headline text-on-surface uppercase mb-1">Send a message</h2>
                  <p className="bv-caption">We reply within one business day.</p>
                </div>

                {/* Name + Email row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div className="flex flex-col gap-1.5">
                    <label className="bv-micro text-on-surface-variant">Name</label>
                    <input
                      type="text"
                      placeholder="Jaqen H'ghar"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      className="w-full px-3.5 py-2.5 rounded-xl text-sm text-on-surface placeholder:text-outline focus:outline-none focus:ring-1 focus:ring-primary/50 transition-all"
                      style={{
                        background: "rgba(255,255,255,0.04)",
                        border: "1px solid var(--bv-glass-border)",
                      }}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="bv-micro text-on-surface-variant">Email</label>
                    <input
                      type="email"
                      placeholder="you@company.com"
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      className="w-full px-3.5 py-2.5 rounded-xl text-sm text-on-surface placeholder:text-outline focus:outline-none focus:ring-1 focus:ring-primary/50 transition-all"
                      style={{
                        background: "rgba(255,255,255,0.04)",
                        border: "1px solid var(--bv-glass-border)",
                      }}
                    />
                  </div>
                </div>

                {/* Topic */}
                <div className="flex flex-col gap-1.5">
                  <label className="bv-micro text-on-surface-variant">Topic</label>
                  <select
                    value={form.topic}
                    onChange={(e) => setForm({ ...form, topic: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-xl text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary/50 transition-all appearance-none"
                    style={{
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid var(--bv-glass-border)",
                    }}
                  >
                    <option value="Sales & pricing">Sales &amp; pricing</option>
                    <option value="Technical support">Technical support</option>
                    <option value="Partnerships">Partnerships</option>
                    <option value="Press">Press</option>
                    <option value="Something else">Something else</option>
                  </select>
                </div>

                {/* Message */}
                <div className="flex flex-col gap-1.5">
                  <label className="bv-micro text-on-surface-variant">Message</label>
                  <textarea
                    placeholder="What can we help you command?"
                    rows={5}
                    value={form.message}
                    onChange={(e) => setForm({ ...form, message: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-xl text-sm text-on-surface placeholder:text-outline focus:outline-none focus:ring-1 focus:ring-primary/50 transition-all resize-none"
                    style={{
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid var(--bv-glass-border)",
                    }}
                  />
                </div>

                <button
                  type="submit"
                  className="bv-btn bv-btn-primary w-full justify-center mt-1"
                  style={{ borderRadius: 14 }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>send</span>
                  Send message
                </button>
              </form>
            ) : (
              /* Success state */
              <div className="flex flex-col items-center text-center py-10">
                <div
                  className="w-16 h-16 rounded-full flex items-center justify-center mb-5 text-primary"
                  style={{
                    background: "rgba(59,130,246,0.14)",
                    border: "1px solid rgba(59,130,246,0.3)",
                  }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 30 }}>check</span>
                </div>
                <h3 className="bv-headline text-on-surface uppercase mb-2">Message forged</h3>
                <p className="bv-caption max-w-[28ch]">
                  {t("static.contact.responseTime")}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-outline-variant/30 mt-16">
        <div className="max-w-[1200px] mx-auto px-6 md:px-10 py-10 grid grid-cols-2 md:grid-cols-4 gap-8">
          <div className="col-span-2 md:col-span-1">
            <a href="/" className="flex items-center gap-2.5 mb-3">
              <div className="bv-avatar" style={{ width: 28, height: 28, borderRadius: 8, fontSize: 11 }}>BL</div>
              <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
            </a>
            <p className="bv-caption max-w-[28ch]">Command the AI agents &amp; automations you already run.</p>
          </div>
          <div className="flex flex-col gap-2">
            <h5 className="bv-micro mb-1">Product</h5>
            <a href="/features" className="bv-caption hover:text-on-surface transition-colors">Features</a>
            <a href="/pricing" className="bv-caption hover:text-on-surface transition-colors">Pricing</a>
            <a href="/changelog" className="bv-caption hover:text-on-surface transition-colors">Changelog</a>
          </div>
          <div className="flex flex-col gap-2">
            <h5 className="bv-micro mb-1">Company</h5>
            <a href="/about" className="bv-caption hover:text-on-surface transition-colors">About</a>
            <a href="/blog" className="bv-caption hover:text-on-surface transition-colors">Blog</a>
            <a href="/status" className="bv-caption hover:text-on-surface transition-colors">Status</a>
          </div>
          <div className="flex flex-col gap-2">
            <h5 className="bv-micro mb-1">Legal</h5>
            <a href="#" className="bv-caption hover:text-on-surface transition-colors">Privacy</a>
            <a href="#" className="bv-caption hover:text-on-surface transition-colors">Terms</a>
            <a href="#" className="bv-caption hover:text-on-surface transition-colors">KVKK</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

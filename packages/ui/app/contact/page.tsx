"use client";
import { useTranslations as useLegacyTranslations } from "next-intl";


import { useTranslations } from "next-intl";
import { useState } from "react";

export default function ContactPage() {
  const uiText = useLegacyTranslations("uiCopy");
  const t = useTranslations();

  // Stable channel keys + matching email addresses; per-locale labels
  // resolve at render time so the row copy translates while emails stay
  // the same.
  const channels = [
    { key: "General", email: "support@yulalab.com", icon: "mail" },
    { key: "Support", email: "support@yulalab.com", icon: "person" },
    { key: "Sales", email: "support@yulalab.com", icon: "handshake" },
    { key: "Privacy", email: "support@yulalab.com", icon: "lock" },
    { key: "Kvkk", email: "support@yulalab.com", icon: "gavel" },
    { key: "Security", email: "support@yulalab.com", icon: "shield" },
  ];

  const [submitted, setSubmitted] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", topic: "Sales & pricing", message: "" });

  // No transactional-mail backend yet, so the form composes a real email
  // in the visitor's mail client instead of pretending to send one.
  const TOPIC_TO_EMAIL: Record<string, string> = {
    "Sales & pricing": "support@yulalab.com",
    "Technical support": "support@yulalab.com",
    "Partnerships": "support@yulalab.com",
    "Press": "support@yulalab.com",
    "Something else": "support@yulalab.com",
  };

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const to = TOPIC_TO_EMAIL[form.topic] ?? "support@yulalab.com";
    const subject = encodeURIComponent(`[${form.topic}] ${form.name || "Website inquiry"}`);
    const body = encodeURIComponent(
      `${form.message}\n\n—\n${form.name}${form.email ? ` · ${form.email}` : ""}`
    );
    window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;
    setSubmitted(true);
  }

  return (
    <div className="min-h-screen bv-mesh">
      {/* Nav */}
      <nav className="flex flex-wrap gap-y-2 items-center justify-between px-6 md:px-10 py-4 max-w-[1200px] mx-auto border-b border-outline-variant/40">
        <a href="/" className="flex items-center gap-2.5">
          <div className="bv-avatar" style={{ width: 32, height: 32, borderRadius: 10, fontSize: 12 }}>{uiText("ma6abe31754db")}</div>
          <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
        </a>
        <div className="order-last basis-full flex overflow-x-auto whitespace-nowrap pb-1 md:order-none md:basis-auto md:overflow-visible md:pb-0 items-center gap-6 text-sm text-on-surface-variant">
          <a href="/features" className="hover:text-on-surface transition-colors">{t("nav.features")}</a>
          <a href="/pricing" className="hover:text-on-surface transition-colors">{t("nav.pricing")}</a>
          <a href="/changelog" className="hover:text-on-surface transition-colors">{t("static.changelog.title")}</a>
        </div>
        <div className="flex items-center gap-2">
          <a href="https://app.braavolabs.com/login" className="bv-btn bv-btn-ghost bv-btn-sm">{t("nav.signIn")}</a>
          <a href="https://app.braavolabs.com" className="bv-btn bv-btn-primary bv-btn-sm">{t("nav.dashboard")}</a>
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
              >{uiText("ma6abe31754db")}</div>
            </div>

            {/* Headline */}
            <h1
              className="font-headline font-semibold uppercase text-on-surface mb-4"
              style={{ fontSize: "clamp(34px, 4.6vw, 52px)", letterSpacing: "-0.02em", lineHeight: 0.98 }}
            >
              {t("static.contact.title")}
            </h1>

            <p className="text-on-surface-variant text-sm mb-8 max-w-[42ch] leading-relaxed">
              {t("static.contact.subtitle")}
            </p>

            {/* Channel list */}
            <div className="flex flex-col gap-3 bv-stagger">
              {channels.map((c) => (
                <a
                  key={c.key}
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
              <form aria-describedby="contact-mail-draft" onSubmit={handleSubmit} className="flex flex-col gap-5">
                <div>
                  <h2 className="bv-headline text-on-surface uppercase mb-1">{t("static.contact.compose")}</h2>
                  <p id="contact-mail-draft" className="bv-caption">{t("static.contact.draftHelp")}</p>
                </div>

                {/* Name + Email row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="contact-name" className="bv-micro text-on-surface-variant">{t("auth.fields.fullName")}</label>
                    <input
                      id="contact-name"
                      name="name"
                      autoComplete="name"
                      required
                      type="text"
                      placeholder={t("auth.fields.fullNamePlaceholder")}
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
                    <label htmlFor="contact-email" className="bv-micro text-on-surface-variant">{t("auth.fields.email")}</label>
                    <input
                      id="contact-email"
                      name="email"
                      autoComplete="email"
                      required
                      type="email"
                      placeholder={t("auth.fields.emailPlaceholder")}
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
                  <label htmlFor="contact-topic" className="bv-micro text-on-surface-variant">{t("static.contact.topic")}</label>
                  <select
                    id="contact-topic"
                    name="topic"
                    value={form.topic}
                    onChange={(e) => setForm({ ...form, topic: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-xl text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary/50 transition-all appearance-none"
                    style={{
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid var(--bv-glass-border)",
                    }}
                  >
                    <option value="Sales & pricing">{t("static.contact.salesTopic")}</option>
                    <option value="Technical support">{t("static.contact.supportTopic")}</option>
                    <option value="Partnerships">{t("static.contact.partnershipsTopic")}</option>
                    <option value="Press">{t("static.contact.pressTopic")}</option>
                    <option value="Something else">{t("static.contact.otherTopic")}</option>
                  </select>
                </div>

                {/* Message */}
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="contact-message" className="bv-micro text-on-surface-variant">{t("static.contact.message")}</label>
                  <textarea
                    id="contact-message"
                    name="message"
                    required
                    placeholder={t("static.contact.messagePlaceholder")}
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
                  {t("static.contact.compose")}
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
                <h3 className="bv-headline text-on-surface uppercase mb-2">{t("static.contact.prepared")}</h3>
                <p className="bv-caption max-w-[34ch]">
                  {t("static.contact.draftHelp")}
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
              <div className="bv-avatar" style={{ width: 28, height: 28, borderRadius: 8, fontSize: 11 }}>{uiText("ma6abe31754db")}</div>
              <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
            </a>
            <p className="bv-caption max-w-[28ch]">{uiText("m2b4a9f22ba8d")}</p>
          </div>
          <div className="flex flex-col gap-2">
            <h5 className="bv-micro mb-1">{uiText("md69e46192627")}</h5>
            <a href="/features" className="bv-caption hover:text-on-surface transition-colors">{t("nav.features")}</a>
            <a href="/pricing" className="bv-caption hover:text-on-surface transition-colors">{t("nav.pricing")}</a>
            <a href="/changelog" className="bv-caption hover:text-on-surface transition-colors">{t("static.changelog.title")}</a>
          </div>
          <div className="flex flex-col gap-2">
            <h5 className="bv-micro mb-1">{uiText("m6d80848fe489")}</h5>
            <a href="/about" className="bv-caption hover:text-on-surface transition-colors">{uiText("m0fb85ef7ffda")}</a>
            <a href="/blog" className="bv-caption hover:text-on-surface transition-colors">{uiText("m260fed5ac47c")}</a>
            <a href="/status" className="bv-caption hover:text-on-surface transition-colors">{uiText("m3a006e3e0878")}</a>
          </div>
          <div className="flex flex-col gap-2">
            <h5 className="bv-micro mb-1">{uiText("md2c8631b73dd")}</h5>
            <a href="/privacy" className="bv-caption hover:text-on-surface transition-colors">{t("footer.privacy")}</a>
            <a href="/terms" className="bv-caption hover:text-on-surface transition-colors">{t("footer.terms")}</a>
            <a href="/kvkk" className="bv-caption hover:text-on-surface transition-colors">KVKK</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

"use client";

import { useTranslations } from "next-intl";
import LanguageSwitcher from "../../components/LanguageSwitcher";

export default function FeaturesPage() {
  const t = useTranslations();
  const features = [
    {
      icon: "smart_toy",
      title: "Autonomous Agents",
      desc: "Claude-powered agents with tool use, retry logic, reasoning logs, and budget controls. Every decision is recorded with a 'why' field.",
      color: "#6d11ad",
    },
    {
      icon: "memory",
      title: "Memory Engine",
      desc: "Episodic + semantic + graph memory. Agents learn from every run. Memories go through candidate → approved → deprecated lifecycle.",
      color: "#00d1ff",
    },
    {
      icon: "account_tree",
      title: "Pipeline Runner",
      desc: "Multi-step workflows with cron scheduling, BullMQ-powered queues, and step-level rollback capability.",
      color: "#e0b6ff",
    },
    {
      icon: "security",
      title: "Governance Engine",
      desc: "Cost anomaly detection, loop prevention, spam protection, brand safety filters. Hard stops on budget overruns.",
      color: "#f87171",
    },
    {
      icon: "query_stats",
      title: "Analytics & CRM",
      desc: "HubSpot integration, deal tracking, full run history, cost breakdown, and success rate metrics.",
      color: "#a4e6ff",
    },
    {
      icon: "credit_card",
      title: "Usage Billing",
      desc: "Stripe-powered metering. Free tier included. Scale from $0 to enterprise on demand with usage-based pricing.",
      color: "#34d399",
    },
    {
      icon: "history",
      title: "Full Audit Log",
      desc: "Every action, every tool call, every decision — permanently logged with actor, timestamp, and cost.",
      color: "#fbbf24",
    },
    {
      icon: "hub",
      title: "9 Primitives",
      desc: "Acquisition, Sales, Delivery, Content, Operations, Finance, Analytics, Memory, Governance — mix and match to build any company type.",
      color: "#00d1ff",
    },
    {
      icon: "task_alt",
      title: "Spend Approval Gates",
      desc: "Only money-spending actions require human approval. Everything else runs autonomously, keeping you in control without slowing ops.",
      color: "#34d399",
    },
  ];

  return (
    <div className="min-h-screen" style={{ background: "#0a0d14" }}>
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 md:px-10 py-5 max-w-[1100px] mx-auto"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
        <a href="/" className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}>
            <span className="text-white font-bold text-xs">AI</span>
          </div>
          <span className="font-headline font-bold text-sm" style={{ color: "#e1e2eb" }}>Braavolabs</span>
        </a>
        <div className="flex items-center gap-4 text-sm" style={{ color: "#859399" }}>
          <a href="/pricing" className="hover:text-white transition-colors">{t("nav.pricing")}</a>
          <LanguageSwitcher />
          <a href="/login" className="px-4 py-2 rounded-xl font-semibold text-white text-xs transition-all hover:brightness-110"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}>
            {t("nav.getStarted")}
          </a>
        </div>
      </nav>

      <div className="max-w-[900px] mx-auto px-6 py-16">
        <div className="text-center mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full mb-5"
            style={{ border: "1px solid rgba(0,209,255,0.25)", background: "rgba(0,209,255,0.06)" }}>
            <span className="text-xs font-semibold tracking-widest" style={{ color: "#00d1ff" }}>PLATFORM CAPABILITIES</span>
          </div>
          <h1 className="font-headline font-extrabold mb-4"
            style={{ fontSize: "clamp(2rem, 4vw, 3rem)", color: "#e1e2eb", lineHeight: 1.1 }}>
            Everything your AI company needs
          </h1>
          <p style={{ color: "#859399", fontSize: "1rem", maxWidth: 480, margin: "0 auto" }}>
            From agent orchestration to memory, billing, and governance — the full stack in one platform.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map((f) => (
            <div key={f.title} className="p-5 rounded-2xl transition-all hover:scale-[1.01]"
              style={{ background: "rgba(29,32,38,0.7)", border: "1px solid rgba(255,255,255,0.05)" }}>
              <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-3"
                style={{ background: `${f.color}18` }}>
                <span className="material-symbols-outlined text-lg" style={{ color: f.color }}>{f.icon}</span>
              </div>
              <p className="font-headline font-bold text-sm mb-1.5" style={{ color: "#e1e2eb" }}>{f.title}</p>
              <p className="text-xs leading-relaxed" style={{ color: "#859399" }}>{f.desc}</p>
            </div>
          ))}
        </div>

        <div className="text-center mt-14">
          <a href="/login"
            className="inline-flex items-center gap-2 px-7 py-3 rounded-xl text-sm font-bold text-white transition-all hover:brightness-110"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", boxShadow: "0 0 24px rgba(0,209,255,0.2)" }}>
            <span className="material-symbols-outlined text-sm">rocket_launch</span>
            Start Building Free
          </a>
        </div>
      </div>
    </div>
  );
}

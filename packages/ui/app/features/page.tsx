"use client";

import { useTranslations } from "next-intl";
import LanguageSwitcher from "../../components/LanguageSwitcher";

export default function FeaturesPage() {
  const t = useTranslations();
  // Identifiers map to keys in messages/*.json under features.items.<id>
  // — title and desc come from i18n so the whole page localizes with a
  // single language switch. Icons and color tokens stay in code because
  // they're presentation, not content.
  const features = [
    { id: "agents", icon: "smart_toy", color: "#6d11ad" },
    { id: "memory", icon: "memory", color: "#00d1ff" },
    { id: "pipeline", icon: "account_tree", color: "#e0b6ff" },
    { id: "governance", icon: "security", color: "#f87171" },
    { id: "analytics", icon: "query_stats", color: "#a4e6ff" },
    { id: "billing", icon: "credit_card", color: "#34d399" },
    { id: "audit", icon: "history", color: "#fbbf24" },
    { id: "primitives", icon: "hub", color: "#00d1ff" },
    { id: "approval", icon: "task_alt", color: "#34d399" },
  ];

  const featureRows = [
    {
      tag: "Visual builder",
      title: "Compose multi-agent teams on a canvas",
      desc: "Drag step types onto a dark DAG canvas. Parallel stages, branches and gates wire together with arc-light edges.",
      bullets: ["Drag-and-drop step palette", "Parallel-aware concurrent lanes", "List ⇄ Canvas, cron scheduling"],
      demo: "dag",
    },
    {
      tag: "The sharpest edge",
      title: "Steer mid-run & answer ask_user",
      desc: "Inject guidance into the agent's next turn, or answer a clarifying question to resume — without re-running anything.",
      bullets: ["Live guidance injection", "ask_user resume loop", "Inline spend-approval gates"],
      demo: "chat",
    },
    {
      tag: "BYOK router",
      title: "Fourteen providers, one router",
      desc: "Bring your own keys and route each step to the best model — swap providers without touching your pipelines.",
      bullets: ["OpenAI · Anthropic · Gemini · Mistral …", "Per-step model routing", "Zero lock-in"],
      demo: "router",
    },
    {
      tag: "Privacy",
      title: "Go local with offline Gemma",
      desc: "Flip a switch and runs go fully on-device — no tokens leave the building. A shield lights arc-blue when local mode is armed.",
      bullets: ["On-device Gemma inference", "Encrypted offline export bundle", "Honest 'installs with the build' state"],
      demo: "offline",
    },
    {
      tag: "Unify",
      title: "n8n, Make & Zapier in one dashboard",
      desc: "Connect and monitor external automations alongside native pipelines — every execution on one audited timeline.",
      bullets: ["Mirror external executions", "One unified activity feed", "Native + external, side by side"],
      demo: "funnel",
    },
    {
      tag: "Governance",
      title: "Five risk-stops, full audit",
      desc: "Every tool call logged, every spend approved, every run audited. Five risk-stops halt runaway agents before they cost you.",
      bullets: ["Hard · loop · cost · spam · brand stops", "SSE real-time runs · CLI · mobile control", "Complete, exportable audit trail"],
      demo: "risk",
    },
  ];

  const providers = ["OpenAI", "Anthropic", "Gemini", "Mistral", "Cohere", "Groq", "xAI", "DeepSeek", "Together", "Fireworks", "Ollama", "Gemma"];
  const riskStops = [
    { label: "hard", status: "bv-failed" },
    { label: "loop", status: "bv-running" },
    { label: "cost", status: "bv-running" },
    { label: "spam", status: "bv-completed" },
    { label: "brand", status: "bv-failed" },
  ];

  return (
    <div className="min-h-screen bv-mesh">
      {/* Nav */}
      <nav
        className="sticky top-0 z-50 glass-panel"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}
      >
        <div className="max-w-[1100px] mx-auto px-6 md:px-10 flex items-center justify-between h-14">
          <a href="/" className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center bv-btn-primary"
              style={{ padding: 0, minHeight: "unset" }}
            >
              <span className="text-white font-bold text-xs">AI</span>
            </div>
            <span className="font-headline font-bold text-sm text-on-surface">Braavolabs</span>
          </a>
          <div className="hidden md:flex items-center gap-6 text-sm">
            <a href="/features" className="text-primary font-medium">{t("nav.features") || "Features"}</a>
            <a href="/pricing" className="text-on-surface-variant hover:text-on-surface transition-colors">{t("nav.pricing")}</a>
            <a href="#" className="text-on-surface-variant hover:text-on-surface transition-colors">{t("nav.integrations") || "Integrations"}</a>
          </div>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            <a href="/login" className="bv-btn bv-btn-ghost bv-btn-sm">{t("nav.signIn") || "Sign in"}</a>
            <a href="/register" className="bv-btn bv-btn-primary bv-btn-sm">
              {t("nav.getStarted")}
            </a>
          </div>
        </div>
      </nav>

      <div className="max-w-[1100px] mx-auto px-6 md:px-10">

        {/* Page header */}
        <header className="text-center pt-24 pb-4 relative">
          <div
            className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2"
            style={{
              width: 520,
              height: 340,
              background: "radial-gradient(circle, rgba(59,130,246,.18), transparent 65%)",
              filter: "blur(20px)",
            }}
          />
          <div className="relative">
            <div
              className="inline-flex items-center gap-2 px-3 py-1 rounded-full mb-5"
              style={{ border: "1px solid rgba(59,130,246,0.25)", background: "rgba(59,130,246,0.06)" }}
            >
              <span className="bv-micro" style={{ color: "#60A5FA" }}>Features</span>
            </div>
            <h1
              className="font-headline font-bold uppercase"
              style={{ fontSize: "clamp(2.5rem,7vw,5.375rem)", lineHeight: 0.92, letterSpacing: "-0.02em" }}
            >
              {t("features.heroLine1") || "Built to"}{" "}
              <em className="not-italic gradient-text">{t("features.heroAccent") || "command"}</em>,
              <br />
              {t("features.heroLine2") || "not to connect."}
            </h1>
            <p className="text-on-surface-variant text-lg max-w-[54ch] mx-auto mt-5">
              {t("features.subtitle") || "Most platforms compete on connector count. Braavolabs competes on control, mobility and privacy — the things that actually matter once your agents are running."}
            </p>
          </div>
        </header>

        {/* Feature rows */}
        <div className="py-4">
          {featureRows.map((row, idx) => (
            <section
              key={row.demo}
              className="reveal grid gap-12 items-center"
              style={{
                gridTemplateColumns: "1fr 1fr",
                padding: "clamp(2.875rem,6vw,4.75rem) 0",
                borderBottom: idx < featureRows.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
              }}
            >
              {/* Copy — even rows flip order */}
              <div
                className="flex flex-col gap-4"
                style={{ order: idx % 2 === 1 ? 2 : undefined }}
              >
                <span className="bv-mono uppercase tracking-widest" style={{ color: "#60A5FA", fontSize: 11 }}>
                  {row.tag}
                </span>
                <h2
                  className="font-headline font-bold uppercase"
                  style={{ fontSize: "clamp(1.625rem,3.4vw,2.5rem)", lineHeight: 1.02, letterSpacing: "-0.01em" }}
                >
                  {row.title}
                </h2>
                <p className="text-on-surface-variant text-base max-w-[46ch]">{row.desc}</p>
                <ul className="flex flex-col gap-2.5 mt-1">
                  {row.bullets.map((b) => (
                    <li key={b} className="flex items-start gap-2.5 text-on-surface-variant text-sm">
                      <span
                        className="mt-1.5 flex-none"
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: 2,
                          background: "#3B82F6",
                          boxShadow: "0 0 8px #3B82F6",
                          display: "inline-block",
                        }}
                      />
                      {b}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Demo panel */}
              <div
                className="bv-glass"
                style={{ height: 300, padding: 24, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", position: "relative" }}
              >
                {/* Demo: DAG */}
                {row.demo === "dag" && (
                  <div style={{ width: "100%", height: "100%", position: "relative" }}>
                    <svg
                      viewBox="0 0 400 240"
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
                    >
                      <path
                        d="M90,60 C150,60 150,120 210,120"
                        style={{ stroke: "#3B82F6", strokeWidth: 2, fill: "none", strokeDasharray: "6 8", filter: "drop-shadow(0 0 3px #3B82F6)" }}
                        className="neural-path"
                      />
                      <path
                        d="M90,180 C150,180 150,120 210,120"
                        style={{ stroke: "#3B82F6", strokeWidth: 2, fill: "none", strokeDasharray: "6 8", filter: "drop-shadow(0 0 3px #3B82F6)" }}
                        className="neural-path"
                      />
                      <path
                        d="M300,120 C330,120 330,120 360,120"
                        style={{ stroke: "#3B82F6", strokeWidth: 2, fill: "none", strokeDasharray: "6 8", filter: "drop-shadow(0 0 3px #3B82F6)" }}
                        className="neural-path"
                      />
                    </svg>
                    {[
                      { label: "trigger", left: "8px", top: "42px" },
                      { label: "agent", left: "8px", top: "162px" },
                      { label: "gate", left: "200px", top: "102px" },
                      { label: "deliver", left: "300px", top: "102px" },
                    ].map((n) => (
                      <div
                        key={n.label}
                        style={{
                          position: "absolute",
                          left: n.left,
                          top: n.top,
                          width: 90,
                          padding: "9px 11px",
                          borderRadius: 10,
                          background: "rgba(20,23,31,0.8)",
                          border: "1px solid rgba(58,65,80,0.6)",
                          fontFamily: "var(--bv-font-mono)",
                          fontSize: 10.5,
                          color: "var(--color-on-surface-variant)",
                        }}
                      >
                        <span
                          style={{
                            display: "inline-block",
                            width: 7,
                            height: 7,
                            borderRadius: "50%",
                            background: "#3B82F6",
                            boxShadow: "0 0 8px #3B82F6",
                            marginRight: 6,
                            verticalAlign: "middle",
                          }}
                        />
                        {n.label}
                      </div>
                    ))}
                  </div>
                )}

                {/* Demo: Chat / mid-run steer */}
                {row.demo === "chat" && (
                  <div className="flex flex-col gap-2.5 w-full justify-center">
                    <div
                      style={{
                        alignSelf: "flex-start",
                        maxWidth: "86%",
                        padding: "10px 13px",
                        borderRadius: "13px 13px 13px 4px",
                        background: "rgba(20,23,31,0.8)",
                        border: "1px solid rgba(58,65,80,0.5)",
                        fontSize: 12.5,
                        lineHeight: 1.4,
                      }}
                    >
                      <span
                        className="block mb-1 bv-mono uppercase"
                        style={{ fontSize: 9, letterSpacing: "0.1em", color: "#60A5FA" }}
                      >
                        agent:sales
                      </span>
                      Approve a $40 outreach budget?
                    </div>
                    <div
                      style={{
                        alignSelf: "flex-end",
                        maxWidth: "86%",
                        padding: "10px 13px",
                        borderRadius: "13px 13px 4px 13px",
                        background: "linear-gradient(135deg,rgba(59,130,246,.22),rgba(37,99,235,.1))",
                        border: "1px solid rgba(96,165,250,.35)",
                        fontSize: 12.5,
                        lineHeight: 1.4,
                        color: "#fff",
                      }}
                    >
                      EU mid-market only, cap $30.
                    </div>
                    <div
                      style={{
                        alignSelf: "flex-start",
                        maxWidth: "86%",
                        padding: "10px 13px",
                        borderRadius: "13px 13px 13px 4px",
                        background: "rgba(20,23,31,0.8)",
                        border: "1px solid rgba(58,65,80,0.5)",
                        fontSize: 12.5,
                        lineHeight: 1.4,
                      }}
                    >
                      <span
                        className="block mb-1 bv-mono uppercase"
                        style={{ fontSize: 9, letterSpacing: "0.1em", color: "#60A5FA" }}
                      >
                        agent:sales
                      </span>
                      Understood — budget set to $30.
                    </div>
                    <div
                      style={{
                        alignSelf: "center",
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        color: "#FF7A1A",
                        fontFamily: "var(--bv-font-mono)",
                        fontSize: 10.5,
                        letterSpacing: "0.08em",
                      }}
                    >
                      <span className="bv-dot bv-running bv-ping" />
                      run resumed · step 13/18
                    </div>
                  </div>
                )}

                {/* Demo: BYOK provider router */}
                {row.demo === "router" && (
                  <div className="flex flex-wrap gap-2 justify-center content-center h-full">
                    {providers.map((p, i) => (
                      <span
                        key={p}
                        className="bv-mono"
                        style={{
                          padding: "9px 13px",
                          borderRadius: 9,
                          background: i === 1 ? "rgba(59,130,246,.12)" : "rgba(20,23,31,0.8)",
                          border: i === 1 ? "1px solid #3B82F6" : "1px solid rgba(58,65,80,0.5)",
                          color: i === 1 ? "#fff" : "var(--color-on-surface-variant)",
                          boxShadow: i === 1 ? "0 0 20px -6px #3B82F6" : undefined,
                          fontSize: 12,
                        }}
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                )}

                {/* Demo: Offline / Gemma shield */}
                {row.demo === "offline" && (
                  <div className="flex flex-col items-center gap-4">
                    <div style={{ position: "relative", width: 96, height: 110, display: "grid", placeItems: "center" }}>
                      <svg
                        viewBox="0 0 96 110"
                        style={{
                          width: 96,
                          height: 110,
                          stroke: "#3B82F6",
                          fill: "rgba(59,130,246,.12)",
                          strokeWidth: 1.5,
                          filter: "drop-shadow(0 0 16px #3B82F6)",
                        }}
                      >
                        <path d="M48 4 L88 20 V54 C88 82 70 100 48 106 C26 100 8 82 8 54 V20 Z" />
                      </svg>
                      <span
                        style={{
                          position: "absolute",
                          fontFamily: "var(--bv-font-mono)",
                          fontSize: 10,
                          color: "#60A5FA",
                        }}
                      >
                        LOCAL
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="bv-mono text-on-surface-variant" style={{ fontSize: 12 }}>On-device · local</span>
                      <div
                        style={{
                          width: 58,
                          height: 30,
                          borderRadius: 999,
                          background: "rgba(59,130,246,.18)",
                          border: "1px solid #3B82F6",
                          position: "relative",
                          cursor: "pointer",
                        }}
                      >
                        <span
                          style={{
                            position: "absolute",
                            top: 3,
                            left: 31,
                            width: 22,
                            height: 22,
                            borderRadius: "50%",
                            background: "#3B82F6",
                            boxShadow: "0 0 12px #3B82F6",
                          }}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* Demo: Funnel — n8n/Make/Zapier */}
                {row.demo === "funnel" && (
                  <div
                    style={{
                      width: "100%",
                      height: "100%",
                      position: "relative",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <svg
                      viewBox="0 0 400 240"
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
                    >
                      {["M120,50 C220,50 220,120 290,120", "M120,120 C220,120 220,120 290,120", "M120,190 C220,190 220,120 290,120"].map(
                        (d, i) => (
                          <path
                            key={i}
                            d={d}
                            style={{ stroke: "#3B82F6", strokeWidth: 2, fill: "none", strokeDasharray: "6 8", filter: "drop-shadow(0 0 3px #3B82F6)" }}
                            className="neural-path"
                          />
                        )
                      )}
                    </svg>
                    <div className="flex flex-col gap-3.5 z-10">
                      {["n8n", "Make", "Zapier"].map((src) => (
                        <div
                          key={src}
                          className="bv-mono"
                          style={{
                            padding: "9px 12px",
                            borderRadius: 9,
                            background: "rgba(20,23,31,0.8)",
                            border: "1px solid rgba(58,65,80,0.5)",
                            color: "var(--color-on-surface-variant)",
                            fontSize: 12,
                          }}
                        >
                          {src}
                        </div>
                      ))}
                    </div>
                    <div
                      style={{
                        width: 96,
                        height: 96,
                        borderRadius: 18,
                        background: "rgba(20,23,31,0.9)",
                        border: "1px solid #3B82F6",
                        boxShadow: "0 0 30px -8px #3B82F6",
                        display: "grid",
                        placeItems: "center",
                        fontFamily: "var(--bv-font-mono)",
                        fontSize: 11,
                        color: "#fff",
                        textAlign: "center",
                        zIndex: 10,
                      }}
                    >
                      one<br />dashboard
                    </div>
                  </div>
                )}

                {/* Demo: Risk stops */}
                {row.demo === "risk" && (
                  <div className="flex flex-wrap gap-2.5 justify-center content-center h-full">
                    {riskStops.map((r) => (
                      <span
                        key={r.label}
                        className="flex items-center gap-2 bv-mono"
                        style={{
                          padding: "9px 14px",
                          borderRadius: 999,
                          background: "rgba(20,23,31,0.8)",
                          border: "1px solid rgba(58,65,80,0.5)",
                          color: "var(--color-on-surface-variant)",
                          fontSize: 12,
                        }}
                      >
                        <span className={`bv-dot ${r.status}`} />
                        {r.label}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </section>
          ))}
        </div>

        {/* Comparison strip */}
        <div className="my-16">
          <div className="bv-glass p-10 text-center reveal">
            <h2
              className="font-headline font-bold uppercase max-w-[22ch] mx-auto"
              style={{ fontSize: "clamp(1.5rem,3.2vw,2.375rem)", lineHeight: 1.1, letterSpacing: "-0.01em" }}
            >
              We compete on control, mobility, privacy &amp; price —{" "}
              <em className="not-italic text-on-surface-variant">not connector count.</em>
            </h2>
            <div className="flex gap-3 justify-center flex-wrap mt-7">
              {["Control", "Mobility", "Privacy", "Flat price"].map((label) => (
                <span key={label} className="bv-pill bv-pill-cyan" style={{ padding: "10px 18px", fontSize: 13 }}>
                  {label}
                </span>
              ))}
            </div>
          </div>
        </div>

      </div>

      {/* CTA section */}
      <section className="text-center pb-24 pt-10">
        <div className="max-w-[1100px] mx-auto px-6 md:px-10">
          <h2
            className="font-headline font-bold uppercase"
            style={{ fontSize: "clamp(1.875rem,5vw,3.75rem)", letterSpacing: "-0.02em" }}
          >
            {t("features.ctaHeadline") || "Forge your workspace."}
          </h2>
          <div className="flex gap-3.5 justify-center mt-7 flex-wrap">
            <a href="/register" className="bv-btn bv-btn-primary">
              <span className="material-symbols-outlined text-sm">rocket_launch</span>
              {t("features.ctaPrimary") || "Start free — 3 runs"}
            </a>
            <a href="/runs" className="bv-btn bv-btn-ghost">
              <span className="material-symbols-outlined text-sm">play_circle</span>
              {t("features.ctaSecondary") || "Watch it steer"}
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

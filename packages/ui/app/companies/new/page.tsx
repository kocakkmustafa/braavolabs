"use client";

import { Suspense, useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSearchParams } from "next/navigation";
import { api } from "../../../lib/api";
import { useAuthGuard } from "../../../lib/useAuthGuard";
import StarterPicker from "../../../components/StarterPicker";
import { useTranslations } from "next-intl";

type WizardStep = "describe" | "clarify" | "preview" | "creating" | "done";

interface BuildSession {
  sessionId: string;
  status: string;
  turn: number;
  companySpec?: any;
  companyId?: string;
  message?: string;
}

interface ChatMessage {
  role: "ai" | "user";
  content: string;
  timestamp: Date;
}

function CompanyBuilderWizardInner() {
  const router = useRouter();
  const { token, hydrated } = useAuthGuard();
  const t = useTranslations();
  const searchParams = useSearchParams();
  const [step, setStep] = useState<WizardStep>("describe");
  const [description, setDescription] = useState(() => {
    const fromUrl = searchParams.get("desc");
    if (fromUrl) return fromUrl;
    try { const fromStorage = sessionStorage.getItem("aicos-build-desc"); if (fromStorage) { sessionStorage.removeItem("aicos-build-desc"); return fromStorage; } } catch {}
    return "";
  });
  const [session, setSession] = useState<BuildSession | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  if (!hydrated || !token) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="bv-dot bv-running bv-ping w-6 h-6" />
      </div>
    );
  }

  function parseAIMessage(msg: any): string {
    const raw = typeof msg === "string" ? msg : JSON.stringify(msg, null, 2);
    const stripped = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    try {
      const parsed = JSON.parse(stripped);
      if (parsed.questions && Array.isArray(parsed.questions)) {
        return parsed.questions.map((q: string, i: number) => `${i + 1}. ${q}`).join("\n\n");
      }
      if (parsed.message) return parsed.message;
      return stripped;
    } catch {
      return raw;
    }
  }

  async function handleDescribe() {
    if (!token) return;
    if (!description.trim()) {
      setError(t("app.companyNew.errDescribe"));
      return;
    }
    setError(null);
    setLoading(true);

    // Add user message to chat
    setChatHistory((prev) => [...prev, { role: "user", content: description.trim(), timestamp: new Date() }]);

    try {
      const res = await api.buildCompany(token, description);
      setSession(res);
      if (res.status === "ready") {
        setChatHistory((prev) => [...prev, { role: "ai", content: t("app.companyNew.specReady"), timestamp: new Date() }]);
        setStep("preview");
      } else {
        const aiMsg = parseAIMessage(res.message);
        setChatHistory((prev) => [...prev, { role: "ai", content: aiMsg, timestamp: new Date() }]);
        setStep("clarify");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.companyNew.failStart"));
    } finally {
      setLoading(false);
    }
  }

  async function handleAnswer() {
    if (!answer.trim() || !session || !token) return;
    setError(null);
    setLoading(true);

    const userMsg = answer.trim();
    setChatHistory((prev) => [...prev, { role: "user", content: userMsg, timestamp: new Date() }]);
    setAnswer("");

    try {
      const res = await api.buildAnswer(token, session.sessionId, userMsg);
      setSession(res);
      if (res.status === "ready") {
        setChatHistory((prev) => [...prev, { role: "ai", content: t("app.companyNew.haveEverything"), timestamp: new Date() }]);
        setStep("preview");
      } else {
        const aiMsg = parseAIMessage(res.message);
        setChatHistory((prev) => [...prev, { role: "ai", content: aiMsg, timestamp: new Date() }]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.companyNew.failContinue"));
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm() {
    if (!session || !token) return;
    setStep("creating");
    setLoading(true);
    try {
      const res = await api.buildConfirm(token, session.sessionId);
      setSession(res);
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.companyNew.failCreate"));
      setStep("preview");
    } finally {
      setLoading(false);
    }
  }

  const stepKeys = ["describe", "clarify", "preview", "done"] as const;
  const currentStepIndex = stepKeys.indexOf(step as any);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-10 animate-fade-in">

      {/* Page head — matches mock .page-head / .eyebrow pattern */}
      <div className="mb-8">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 mb-4">
          <a href="/companies" className="bv-micro hover:text-on-surface transition-colors" style={{ color: "var(--color-outline)" }}>
            Workspaces
          </a>
          <span className="material-symbols-outlined" style={{ fontSize: 14, color: "var(--color-outline)" }}>chevron_right</span>
          <span className="bv-micro" style={{ color: "var(--color-on-surface-variant)" }}>New</span>
        </div>

        {/* Hero title — matches mock h1 + lede */}
        <h1
          className="font-headline text-center leading-none tracking-tight mb-3"
          style={{
            fontFamily: "var(--bv-font-display)",
            fontSize: "clamp(28px, 4vw, 44px)",
            fontWeight: 700,
            letterSpacing: "-0.02em",
            textTransform: "uppercase",
            color: "var(--color-on-surface)",
          }}
        >
          {t("app.companyNew.title").split(" ").slice(0, -1).join(" ")}{" "}
          <span className="bv-grad-text">{t("app.companyNew.title").split(" ").slice(-1)[0]}</span>
        </h1>
        <p
          className="text-center mx-auto"
          style={{
            color: "var(--color-on-surface-variant)",
            fontSize: 15,
            maxWidth: "50ch",
            lineHeight: 1.6,
          }}
        >
          {t("app.companyNew.subtitle")}
        </p>
      </div>

      {/* Progress steps — FORGE pill stepper */}
      <div className="flex items-center justify-center mb-8 gap-2">
        {stepKeys.map((s, i) => (
          <div key={s} className="flex items-center">
            <div
              className="flex items-center justify-center text-xs font-semibold transition-all"
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                background: step === s
                  ? "var(--bv-gradient-brand)"
                  : currentStepIndex > i
                    ? "rgba(59,130,246,0.15)"
                    : "rgba(255,255,255,0.04)",
                border: step === s
                  ? "none"
                  : currentStepIndex > i
                    ? "1px solid rgba(59,130,246,0.3)"
                    : "1px solid var(--bv-glass-border)",
                color: step === s
                  ? "#fff"
                  : currentStepIndex > i
                    ? "#60A5FA"
                    : "var(--color-outline)",
                boxShadow: step === s ? "0 0 16px rgba(59,130,246,0.35)" : "none",
              }}
            >
              {currentStepIndex > i
                ? <span className="material-symbols-outlined" style={{ fontSize: 14 }}>check</span>
                : i + 1}
            </div>
            {i < 3 && (
              <div
                style={{
                  width: 36,
                  height: 1,
                  margin: "0 4px",
                  background: currentStepIndex > i
                    ? "rgba(59,130,246,0.4)"
                    : "var(--bv-glass-border)",
                }}
              />
            )}
          </div>
        ))}
      </div>

      {/* Error banner */}
      {error && (
        <div
          className="flex items-start gap-3 px-4 py-3 rounded-xl mb-5 text-sm"
          style={{
            background: "rgba(255,77,77,0.08)",
            border: "1px solid rgba(255,77,77,0.2)",
            color: "#FF8A8A",
          }}
        >
          <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 18, color: "#FF4D4D", marginTop: 1 }}>error</span>
          <span>
            {error}
            {(error.toLowerCase().includes("limit") || error.toLowerCase().includes("plan")) && (
              <a href="/pricing" className="ml-2 underline" style={{ color: "#60A5FA" }}>Upgrade plan</a>
            )}
          </span>
        </div>
      )}

      {/* ── Step 1: Describe ── */}
      {step === "describe" && (
        <div className="bv-stagger">
          {/* Template gallery — StarterPicker unchanged */}
          <StarterPicker
            token={token}
            onCloned={(company, message) => {
              try { sessionStorage.setItem("aicos-toast", message); } catch {}
              router.push(`/companies/${company.id}`);
            }}
          />

          {/* Prompt box — matches mock .promptbox inside .steel-card */}
          <div
            className="bv-glass"
            style={{ padding: 0, overflow: "hidden" }}
          >
            {/* Textarea area */}
            <textarea
              value={description}
              onChange={(e) => { setDescription(e.target.value); setError(null); }}
              rows={5}
              required
              className="w-full resize-none bg-transparent outline-none text-base px-5 pt-5 pb-3"
              style={{
                color: "var(--color-on-surface)",
                fontSize: 16,
                lineHeight: 1.6,
                border: "none",
                fontFamily: "var(--bv-font-body)",
              }}
              placeholder={t("app.companyNew.descPlaceholder")}
            />

            {/* Validation messages */}
            {description.length > 0 && description.length < 10 && (
              <p className="px-5 pb-1 text-xs" style={{ color: "#FF8A8A" }}>
                {t("app.companyNew.minChars", { n: 10 - description.length })}
              </p>
            )}
            {touched && description.length === 0 && (
              <p className="px-5 pb-1 text-xs" style={{ color: "#FF8A8A" }}>
                {t("app.companyNew.enterDesc")}
              </p>
            )}

            {/* Footer toolbar — matches mock .pf */}
            <div
              className="flex items-center px-4 py-3"
              style={{ borderTop: "1px solid var(--bv-glass-border)" }}
            >
              <span className="bv-mono" style={{ color: "var(--color-outline)", fontSize: 11 }}>
                ⌘↵ to forge
              </span>
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={(e) => { setTouched(true); if (description.length >= 10) handleDescribe(); }}
                  disabled={loading}
                  className="bv-btn bv-btn-primary bv-sheen disabled:opacity-50 disabled:cursor-not-allowed"
                  onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { setTouched(true); if (description.length >= 10) handleDescribe(); } }}
                >
                  {loading ? (
                    <>
                      <span className="inline-block w-3.5 h-3.5 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(255,255,255,0.3)", borderTopColor: "#fff" }} />
                      {t("app.companyNew.analyzing")}
                    </>
                  ) : (
                    <>
                      {t("app.companyNew.continueBtn")}
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_forward</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          {loading && (
            <p className="text-center text-xs mt-2" style={{ color: "var(--bv-text-faint)" }}>
              {t("app.companyNew.mayTake")}
            </p>
          )}
        </div>
      )}

      {/* ── Step 2: Clarification Chat ── */}
      {step === "clarify" && session && (
        <div className="bv-glass" style={{ overflow: "hidden", maxHeight: "65vh", display: "flex", flexDirection: "column" }}>

          {/* Chat header */}
          <div
            className="flex items-center justify-between px-5 py-3 flex-shrink-0"
            style={{ borderBottom: "1px solid var(--bv-glass-border)" }}
          >
            <div className="flex items-center gap-2">
              <div
                className="flex items-center justify-center"
                style={{ width: 28, height: 28, borderRadius: 8, background: "var(--bv-gradient-brand)" }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16, color: "#fff" }}>smart_toy</span>
              </div>
              <span className="font-semibold" style={{ fontSize: 14, color: "var(--color-on-surface)", fontFamily: "var(--bv-font-display)" }}>
                {t("app.companyNew.builderTitle")}
              </span>
            </div>
            <span className="bv-pill bv-pill-cyan">
              {t("app.companyNew.round", { turn: session.turn })}
            </span>
          </div>

          {/* Chat messages */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4" style={{ minHeight: 200 }}>
            {chatHistory.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className="max-w-[85%] text-sm"
                  style={{
                    padding: "12px 16px",
                    background: msg.role === "user"
                      ? "linear-gradient(135deg,rgba(59,130,246,0.18),rgba(37,99,235,0.12))"
                      : "rgba(255,255,255,0.04)",
                    border: msg.role === "user"
                      ? "1px solid rgba(59,130,246,0.28)"
                      : "1px solid var(--bv-glass-border)",
                    borderRadius: msg.role === "user" ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
                    color: "var(--color-on-surface)",
                  }}
                >
                  {msg.role === "ai" && (
                    <div className="flex items-center gap-1.5 mb-2">
                      <span className="bv-mono" style={{ color: "#60A5FA", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                        braavolabs
                      </span>
                    </div>
                  )}
                  <div className="whitespace-pre-wrap leading-relaxed" style={{ color: msg.role === "ai" ? "var(--color-on-surface-variant)" : "var(--color-on-surface)" }}>
                    {msg.content}
                  </div>
                </div>
              </div>
            ))}

            {/* Typing indicator */}
            {loading && (
              <div className="flex justify-start">
                <div
                  style={{
                    padding: "12px 16px",
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid var(--bv-glass-border)",
                    borderRadius: "18px 18px 18px 4px",
                  }}
                >
                  <div className="flex gap-1.5">
                    {[0, 150, 300].map((delay) => (
                      <div
                        key={delay}
                        className="w-2 h-2 rounded-full animate-bounce"
                        style={{ background: "#60A5FA", animationDelay: `${delay}ms` }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Chat input */}
          <div
            className="px-4 py-3 flex-shrink-0"
            style={{ borderTop: "1px solid var(--bv-glass-border)" }}
          >
            <div className="flex gap-2">
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAnswer(); }
                }}
                rows={2}
                className="flex-1 rounded-xl px-4 py-2.5 text-sm resize-none outline-none"
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid var(--bv-glass-border)",
                  color: "var(--color-on-surface)",
                  fontFamily: "var(--bv-font-body)",
                  transition: "border-color 200ms",
                }}
                placeholder={t("app.companyNew.answerPlaceholder")}
                onFocus={(e) => { e.currentTarget.style.borderColor = "rgba(59,130,246,0.4)"; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bv-glass-border)"; }}
              />
              <button
                onClick={handleAnswer}
                disabled={loading || answer.length < 1}
                className="bv-btn bv-btn-primary bv-btn-icon disabled:opacity-50"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>send</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Step 3: Preview ── */}
      {step === "preview" && session?.companySpec && (
        <div className="bv-glass bv-rise" style={{ padding: "24px 28px" }}>
          <div className="bv-panel-head mb-5">
            <div>
              <p className="bv-micro mb-1" style={{ color: "var(--color-outline)" }}>Workspace spec</p>
              <h2 className="bv-headline" style={{ color: "var(--color-on-surface)" }}>
                {t("app.companyNew.previewTitle")}
              </h2>
            </div>
            <div className="bv-dot bv-running bv-ping" />
          </div>

          <div className="space-y-5">
            {/* Name */}
            <div>
              <p className="bv-micro mb-1" style={{ color: "var(--color-outline)" }}>{t("app.companyNew.colName")}</p>
              <p className="bv-title text-lg">{session.companySpec.name}</p>
            </div>

            {/* Description */}
            <div>
              <p className="bv-micro mb-1" style={{ color: "var(--color-outline)" }}>{t("app.companyNew.colDescription")}</p>
              <p className="bv-body" style={{ color: "var(--color-on-surface-variant)" }}>{session.companySpec.description}</p>
            </div>

            {/* Primitives */}
            {session.companySpec.primitives?.length > 0 && (
              <div>
                <p className="bv-micro mb-2" style={{ color: "var(--color-outline)" }}>{t("app.companyNew.colPrimitives")}</p>
                <div className="flex flex-wrap gap-2">
                  {session.companySpec.primitives.map((p: string) => (
                    <span key={p} className="bv-pill bv-pill-cyan">{p}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Divider */}
            <div className="bv-divider" />

            {/* Agents */}
            <div>
              <p className="bv-micro mb-2" style={{ color: "var(--color-outline)" }}>
                {t("app.companyNew.colAgents", { n: session.companySpec.agents?.length ?? 0 })}
              </p>
              <div className="bv-agentgrid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(140px,1fr))" }}>
                {session.companySpec.agents?.map((a: any, i: number) => (
                  <div key={i} className="bv-agentcard">
                    <div className="bv-agentcard-head">
                      <div className="bv-dot bv-completed" />
                    </div>
                    <p className="bv-agentcard-name">{a.name}</p>
                    <p className="bv-agentcard-role">{a.role}</p>
                    {a.tools?.length > 0 && (
                      <p className="bv-micro mt-1" style={{ color: "var(--bv-text-faint)", textTransform: "none", letterSpacing: 0, fontSize: 10 }}>
                        {t("app.companyNew.toolsLabel", { tools: a.tools.join(", ") })}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Pipelines */}
            {session.companySpec.pipelines?.length > 0 && (
              <div>
                <div className="bv-divider mb-4" />
                <p className="bv-micro mb-2" style={{ color: "var(--color-outline)" }}>
                  {t("app.companyNew.colPipelines", { n: session.companySpec.pipelines?.length ?? 0 })}
                </p>
                <div className="space-y-2">
                  {session.companySpec.pipelines.map((p: any, i: number) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 rounded-xl px-3 py-2.5"
                      style={{
                        background: "rgba(255,255,255,0.03)",
                        border: "1px solid var(--bv-glass-border)",
                      }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 16, color: "var(--color-outline)" }}>
                        account_tree
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold truncate" style={{ color: "var(--color-on-surface)" }}>{p.name}</p>
                        <p className="bv-caption truncate">{p.trigger}</p>
                      </div>
                      <span className="bv-pill bv-pill-muted">
                        {t("app.companyNew.stepsLabel", { n: p.steps?.length ?? 0 })}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* CTA row */}
          <div className="flex gap-3 mt-6">
            <button
              onClick={() => {
                if (window.confirm(t("app.companyNew.confirmReset"))) {
                  setSession(null); setDescription(""); setAnswer(""); setError(null); setChatHistory([]); setStep("describe");
                }
              }}
              className="bv-btn bv-btn-ghost flex-1"
            >
              {t("app.companyNew.startOver")}
            </button>
            <button
              onClick={handleConfirm}
              disabled={loading}
              className="bv-btn bv-btn-primary bv-sheen flex-1 disabled:opacity-50"
            >
              {loading ? (
                <>
                  <span className="inline-block w-3.5 h-3.5 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(255,255,255,0.3)", borderTopColor: "#fff" }} />
                  {t("app.companyNew.creating")}
                </>
              ) : (
                <>
                  {t("app.companyNew.createCompany")}
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>rocket_launch</span>
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 4: Creating (forge constellation) ── */}
      {step === "creating" && (
        <div className="bv-glass bv-rise" style={{ padding: "48px 32px", textAlign: "center" }}>
          {/* Title */}
          <h2
            className="bv-headline mb-2"
            style={{ fontFamily: "var(--bv-font-display)", textTransform: "uppercase", letterSpacing: "-0.02em", color: "var(--color-on-surface)" }}
          >
            {t("app.companyNew.buildingTitle")}
          </h2>
          <p className="bv-body mb-8" style={{ color: "var(--color-on-surface-variant)" }}>
            {t("app.companyNew.buildingBody")}
          </p>

          {/* Constellation of agent nodes */}
          <div className="relative mx-auto mb-6" style={{ width: "100%", maxWidth: 520, height: 280 }}>
            {/* SVG edges */}
            <svg
              viewBox="0 0 520 280"
              className="absolute inset-0 w-full h-full pointer-events-none"
              aria-hidden="true"
            >
              {[
                [260, 140, 260, 30],
                [260, 140, 390, 70],
                [260, 140, 450, 180],
                [260, 140, 370, 260],
                [260, 140, 150, 260],
                [260, 140, 70, 180],
                [260, 140, 130, 70],
              ].map(([x1, y1, x2, y2], i) => (
                <line
                  key={i}
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke="rgba(59,130,246,0.2)"
                  strokeWidth={1}
                />
              ))}
            </svg>

            {/* Core node */}
            <div
              className="absolute flex flex-col items-center justify-center gap-1"
              style={{
                left: 260, top: 140,
                transform: "translate(-50%,-50%)",
                width: 56, height: 56,
                borderRadius: 14,
                background: "var(--bv-gradient-brand)",
                boxShadow: "0 0 28px rgba(59,130,246,0.45)",
                border: "none",
              }}
            >
              <div className="bv-dot bv-running" style={{ width: 6, height: 6 }} />
              <span className="bv-mono" style={{ fontSize: 9, color: "#fff", letterSpacing: "0.08em" }}>core</span>
            </div>

            {/* Outer agent nodes */}
            {[
              { label: "acq.", x: 260, y: 30 },
              { label: "sales", x: 390, y: 70 },
              { label: "ops", x: 450, y: 180 },
              { label: "anlyt", x: 370, y: 260 },
              { label: "mem", x: 150, y: 260 },
              { label: "cont.", x: 70, y: 180 },
              { label: "gov", x: 130, y: 70 },
            ].map(({ label, x, y }) => (
              <div
                key={label}
                className="absolute flex flex-col items-center justify-center gap-1 animate-pulse"
                style={{
                  left: x, top: y,
                  transform: "translate(-50%,-50%)",
                  width: 48, height: 48,
                  borderRadius: 12,
                  background: "rgba(15,18,25,0.85)",
                  border: "1px solid rgba(59,130,246,0.25)",
                  backdropFilter: "blur(10px)",
                }}
              >
                <div className="bv-dot bv-completed" style={{ width: 6, height: 6 }} />
                <span className="bv-mono" style={{ fontSize: 8, color: "var(--color-outline)", letterSpacing: "0.06em" }}>{label}</span>
              </div>
            ))}
          </div>

          {/* Spinner */}
          <div
            className="w-12 h-12 rounded-full border-2 animate-spin mx-auto"
            style={{ borderColor: "rgba(59,130,246,0.2)", borderTopColor: "#60A5FA" }}
          />
        </div>
      )}

      {/* ── Step 5: Done ── */}
      {step === "done" && session && (
        <div className="bv-glass bv-rise" style={{ padding: "48px 32px", textAlign: "center" }}>
          {/* Success icon */}
          <div
            className="flex items-center justify-center mx-auto mb-5"
            style={{
              width: 64,
              height: 64,
              borderRadius: 18,
              background: "rgba(59,130,246,0.1)",
              border: "1px solid rgba(59,130,246,0.25)",
              boxShadow: "0 0 30px rgba(59,130,246,0.2)",
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 32, color: "#60A5FA" }}>check_circle</span>
          </div>

          <h2 className="bv-headline mb-2" style={{ color: "var(--color-on-surface)" }}>
            {t("app.companyNew.doneTitle")}
          </h2>
          <p className="bv-body mb-8" style={{ color: "var(--color-on-surface-variant)" }}>
            {t("app.companyNew.doneBody", { name: session.companySpec?.name ?? "" })}
          </p>

          <button
            onClick={() => router.push("/companies")}
            className="bv-btn bv-btn-primary bv-sheen"
          >
            {t("app.companyNew.goToCompanies")}
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_forward</span>
          </button>
        </div>
      )}
    </div>
  );
}

export default function CompanyBuilderWizard() {
  const t = useTranslations();
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen" style={{ background: "var(--color-background)" }}>
          <div className="bv-dot bv-running bv-ping" style={{ width: 10, height: 10 }} />
          <span className="ml-3 bv-body" style={{ color: "var(--color-outline)" }}>
            {t("app.companyNew.loading")}
          </span>
        </div>
      }
    >
      <CompanyBuilderWizardInner />
    </Suspense>
  );
}

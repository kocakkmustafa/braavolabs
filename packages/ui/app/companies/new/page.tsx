"use client";

import { Suspense, useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSearchParams } from "next/navigation";
import { api } from "../../../lib/api";
import { useAuthGuard } from "../../../lib/useAuthGuard";
import StarterPicker from "../../../components/StarterPicker";

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
        <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(0,209,255,0.3)", borderTopColor: "#00d1ff" }} />
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
      setError("Please describe your company idea before continuing.");
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
        setChatHistory((prev) => [...prev, { role: "ai", content: "Your company spec is ready! Review it below.", timestamp: new Date() }]);
        setStep("preview");
      } else {
        const aiMsg = parseAIMessage(res.message);
        setChatHistory((prev) => [...prev, { role: "ai", content: aiMsg, timestamp: new Date() }]);
        setStep("clarify");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start build");
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
        setChatHistory((prev) => [...prev, { role: "ai", content: "I have everything I need. Here's your company preview!", timestamp: new Date() }]);
        setStep("preview");
      } else {
        const aiMsg = parseAIMessage(res.message);
        setChatHistory((prev) => [...prev, { role: "ai", content: aiMsg, timestamp: new Date() }]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to continue");
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
      setError(err instanceof Error ? err.message : "Failed to create company");
      setStep("preview");
    } finally {
      setLoading(false);
    }
  }

  const stepKeys = ["describe", "clarify", "preview", "done"] as const;
  const currentStepIndex = stepKeys.indexOf(step as any);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">
      <div className="mb-6">
        <h1 className="text-xl sm:text-2xl font-bold font-headline" style={{ color: "#e1e2eb" }}>Create AI Company</h1>
        <p className="text-sm mt-1" style={{ color: "#859399" }}>Describe your company idea and let AI build it for you.</p>
      </div>

      {/* Progress Steps */}
      <div className="flex items-center mb-6 gap-2">
        {stepKeys.map((s, i) => (
          <div key={s} className="flex items-center">
            <div
              className="w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-xs font-semibold transition-all"
              style={{
                background: step === s ? "linear-gradient(135deg, #00d1ff, #6d11ad)" : currentStepIndex > i ? "rgba(52,211,153,0.2)" : "rgba(255,255,255,0.06)",
                border: step === s ? "none" : currentStepIndex > i ? "1px solid rgba(52,211,153,0.3)" : "1px solid rgba(255,255,255,0.08)",
                color: step === s ? "white" : currentStepIndex > i ? "#34d399" : "#859399",
              }}
            >
              {currentStepIndex > i ? "✓" : i + 1}
            </div>
            {i < 3 && <div className="w-8 sm:w-12 h-0.5 mx-1" style={{ background: currentStepIndex > i ? "rgba(52,211,153,0.4)" : "rgba(255,255,255,0.08)" }} />}
          </div>
        ))}
      </div>

      {error && (
        <div className="px-4 py-3 rounded-xl mb-4 text-sm" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "#f87171" }}>
          {error}
          {(error.toLowerCase().includes("limit") || error.toLowerCase().includes("plan")) && (
            <a href="/pricing" className="ml-2 underline" style={{ color: "#a4e6ff" }}>Upgrade plan</a>
          )}
        </div>
      )}

      {/* Step 1: Describe (with quick-start starter cards on top) */}
      {step === "describe" && (
        <>
          {/* Pre-baked templates — clone in one click. Bypasses the AI
              builder so it costs zero trial Groq runs; the user spends
              their first run on actually executing the cloned pipeline. */}
          <StarterPicker
            token={token}
            onCloned={(company, message) => {
              // After clone we drop straight into the company page so the
              // user can see what was created and run the demo pipeline.
              try { sessionStorage.setItem("aicos-toast", message); } catch {}
              router.push(`/companies/${company.id}`);
            }}
          />

          <div className="glass-card rounded-2xl p-5 sm:p-6">
            <h2 className="text-base sm:text-lg font-semibold font-headline mb-3" style={{ color: "#e1e2eb" }}>Describe Your Company</h2>
          <p className="text-sm mb-4" style={{ color: "#859399" }}>
            Tell us what kind of AI company you want to build. Be as detailed as possible.
          </p>
          <textarea
            value={description}
            onChange={(e) => { setDescription(e.target.value); setError(null); }}
            rows={5}
            required
            className="w-full rounded-xl px-4 py-3 text-sm resize-none transition-all"
            style={{
              background: "rgba(255,255,255,0.04)",
              border: description.length > 0 && description.length < 10
                ? "1px solid rgba(239,68,68,0.5)"
                : "1px solid rgba(255,255,255,0.08)",
              color: "#e1e2eb",
              outline: "none",
            }}
            placeholder="E.g.: I want to build a content agency for Instagram and TikTok. My target market is small businesses..."
            onFocus={(e) => { e.currentTarget.style.borderColor = "rgba(0,209,255,0.4)"; }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = description.length > 0 && description.length < 10
                ? "rgba(239,68,68,0.5)"
                : "rgba(255,255,255,0.08)";
            }}
          />
          {description.length > 0 && description.length < 10 && (
            <p className="mt-1.5 text-xs" style={{ color: "#f87171" }}>
              Please describe your company idea in at least 10 characters ({10 - description.length} more needed).
            </p>
          )}
          {touched && description.length === 0 && (
            <p className="mt-1.5 text-xs" style={{ color: "#f87171" }}>
              Please enter a description for your AI company to continue.
            </p>
          )}
          <button
            onClick={(e) => { setTouched(true); if (description.length >= 10) handleDescribe(); }}
            disabled={loading}
            className="mt-4 w-full text-white py-2.5 rounded-xl font-semibold flex items-center justify-center gap-2 transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
          >
            {loading ? (
              <>
                <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                AI is analyzing your idea...
              </>
            ) : "Continue"}
          </button>
          {loading && (
            <p className="mt-2 text-center text-xs" style={{ color: "#3c494e" }}>This may take 15-30 seconds</p>
          )}
          </div>
        </>
      )}

      {/* Step 2: Clarification Chat */}
      {step === "clarify" && session && (
        <div className="glass-card rounded-2xl overflow-hidden flex flex-col" style={{ maxHeight: "65vh" }}>
          {/* Chat header */}
          <div className="px-5 py-3 flex items-center justify-between flex-shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined" style={{ fontSize: 18, color: "#00d1ff" }}>smart_toy</span>
              <span className="text-sm font-semibold" style={{ color: "#e1e2eb" }}>AI Company Builder</span>
            </div>
            <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: "rgba(0,209,255,0.08)", color: "#a4e6ff" }}>
              Round {session.turn}/3
            </span>
          </div>

          {/* Chat messages */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4" style={{ minHeight: 200 }}>
            {chatHistory.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className="max-w-[85%] rounded-2xl px-4 py-3 text-sm"
                  style={{
                    background: msg.role === "user"
                      ? "linear-gradient(135deg, rgba(0,209,255,0.15), rgba(109,17,173,0.15))"
                      : "rgba(255,255,255,0.04)",
                    border: msg.role === "user"
                      ? "1px solid rgba(0,209,255,0.25)"
                      : "1px solid rgba(255,255,255,0.06)",
                    borderRadius: msg.role === "user" ? "20px 20px 4px 20px" : "20px 20px 20px 4px",
                    color: "#e1e2eb",
                  }}
                >
                  {msg.role === "ai" && (
                    <div className="flex items-center gap-1.5 mb-2">
                      <div className="w-5 h-5 rounded-full flex items-center justify-center" style={{ background: "linear-gradient(135deg,#00d1ff,#6d11ad)" }}>
                        <span style={{ color: "white", fontSize: 8, fontWeight: 700 }}>AI</span>
                      </div>
                      <span className="text-[10px] font-semibold" style={{ color: "#00d1ff" }}>Claude</span>
                    </div>
                  )}
                  <div className="whitespace-pre-wrap leading-relaxed" style={{ color: msg.role === "ai" ? "#bbc9cf" : "#e1e2eb" }}>
                    {msg.content}
                  </div>
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="rounded-2xl px-4 py-3" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "20px 20px 20px 4px" }}>
                  <div className="flex gap-1.5">
                    <div className="w-2 h-2 rounded-full animate-bounce" style={{ background: "#00d1ff", animationDelay: "0ms" }} />
                    <div className="w-2 h-2 rounded-full animate-bounce" style={{ background: "#00d1ff", animationDelay: "150ms" }} />
                    <div className="w-2 h-2 rounded-full animate-bounce" style={{ background: "#00d1ff", animationDelay: "300ms" }} />
                  </div>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Chat input */}
          <div className="px-4 py-3 flex-shrink-0" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
            <div className="flex gap-2">
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAnswer(); }
                }}
                rows={2}
                className="flex-1 rounded-xl px-4 py-2.5 text-sm resize-none outline-none"
                style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }}
                placeholder="Type your answer... (Enter to send, Shift+Enter for new line)"
                onFocus={(e) => { e.currentTarget.style.border = "1px solid rgba(0,209,255,0.4)"; }}
                onBlur={(e) => { e.currentTarget.style.border = "1px solid rgba(255,255,255,0.08)"; }}
              />
              <button
                onClick={handleAnswer}
                disabled={loading || answer.length < 1}
                className="px-4 rounded-xl text-white font-semibold disabled:opacity-50 flex-shrink-0"
                style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>send</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Step 3: Preview */}
      {step === "preview" && session?.companySpec && (
        <div className="glass-card rounded-2xl p-5 sm:p-6">
          <h2 className="text-base sm:text-lg font-semibold font-headline mb-4" style={{ color: "#e1e2eb" }}>Company Preview</h2>

          <div className="space-y-4">
            <div>
              <label className="text-xs font-semibold tracking-wider" style={{ color: "#859399" }}>NAME</label>
              <p className="text-lg font-semibold mt-1" style={{ color: "#e1e2eb" }}>{session.companySpec.name}</p>
            </div>
            <div>
              <label className="text-xs font-semibold tracking-wider" style={{ color: "#859399" }}>DESCRIPTION</label>
              <p className="text-sm mt-1" style={{ color: "#bbc9cf" }}>{session.companySpec.description}</p>
            </div>
            <div>
              <label className="text-xs font-semibold tracking-wider" style={{ color: "#859399" }}>PRIMITIVES</label>
              <div className="flex flex-wrap gap-2 mt-2">
                {session.companySpec.primitives?.map((p: string) => (
                  <span key={p} className="px-2.5 py-1 text-xs rounded-lg font-semibold" style={{ background: "rgba(0,209,255,0.1)", color: "#a4e6ff", border: "1px solid rgba(0,209,255,0.2)" }}>
                    {p}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold tracking-wider" style={{ color: "#859399" }}>AGENTS ({session.companySpec.agents?.length ?? 0})</label>
              <div className="mt-2 space-y-2">
                {session.companySpec.agents?.map((a: any, i: number) => (
                  <div key={i} className="rounded-xl p-3 text-sm" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                    <span className="font-medium" style={{ color: "#e1e2eb" }}>{a.name}</span>
                    <span className="ml-2" style={{ color: "#859399" }}>({a.role})</span>
                    {a.tools?.length > 0 && <div className="text-xs mt-1" style={{ color: "#3c494e" }}>Tools: {a.tools.join(", ")}</div>}
                  </div>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold tracking-wider" style={{ color: "#859399" }}>PIPELINES ({session.companySpec.pipelines?.length ?? 0})</label>
              <div className="mt-2 space-y-2">
                {session.companySpec.pipelines?.map((p: any, i: number) => (
                  <div key={i} className="rounded-xl p-3 text-sm" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                    <span className="font-medium" style={{ color: "#e1e2eb" }}>{p.name}</span>
                    <span className="ml-2" style={{ color: "#859399" }}>({p.trigger})</span>
                    <div className="text-xs mt-1" style={{ color: "#3c494e" }}>{p.steps?.length ?? 0} steps</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="flex gap-3 mt-6">
            <button
              onClick={() => {
                if (window.confirm("Are you sure? All progress will be lost.")) {
                  setSession(null); setDescription(""); setAnswer(""); setError(null); setChatHistory([]); setStep("describe");
                }
              }}
              className="flex-1 py-2.5 rounded-xl font-semibold transition-colors hover:opacity-80"
              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#bbc9cf" }}
            >
              Start Over
            </button>
            <button
              onClick={handleConfirm}
              disabled={loading}
              className="flex-1 text-white py-2.5 rounded-xl font-semibold transition-all hover:brightness-110 disabled:opacity-50"
              style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
            >
              {loading ? "Creating..." : "Create Company"}
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Creating */}
      {step === "creating" && (
        <div className="glass-card rounded-2xl p-12 text-center">
          <div className="w-16 h-16 rounded-full border-2 animate-spin mx-auto mb-6" style={{ borderColor: "rgba(0,209,255,0.3)", borderTopColor: "#00d1ff" }} />
          <p className="text-lg font-semibold font-headline" style={{ color: "#e1e2eb" }}>Building your AI company...</p>
          <p className="text-sm mt-2" style={{ color: "#859399" }}>Setting up agents, pipelines, and tools.</p>
        </div>
      )}

      {/* Step 5: Done */}
      {step === "done" && session && (
        <div className="glass-card rounded-2xl p-8 text-center">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5" style={{ background: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.2)" }}>
            <span className="material-symbols-outlined text-3xl" style={{ color: "#34d399" }}>check_circle</span>
          </div>
          <h2 className="text-2xl font-bold font-headline mb-2" style={{ color: "#e1e2eb" }}>Company Created!</h2>
          <p className="mb-6" style={{ color: "#859399" }}>{session.companySpec?.name} is ready to go.</p>
          <button
            onClick={() => router.push("/companies")}
            className="text-white px-6 py-2.5 rounded-xl font-semibold transition-all hover:brightness-110"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
          >
            Go to Companies
          </button>
        </div>
      )}
    </div>
  );
}

export default function CompanyBuilderWizard() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen" style={{ background: "#0a0d14" }}><span style={{ color: "#859399" }}>Loading...</span></div>}>
      <CompanyBuilderWizardInner />
    </Suspense>
  );
}

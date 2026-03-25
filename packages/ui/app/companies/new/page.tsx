"use client";

import { Suspense, useState } from "react";
import { useRouter } from "next/navigation";
import { useSearchParams } from "next/navigation";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../lib/store";

type WizardStep = "describe" | "clarify" | "preview" | "creating" | "done";

interface BuildSession {
  sessionId: string;
  status: string;
  turn: number;
  companySpec?: any;
  companyId?: string;
  message?: string;
}

function CompanyBuilderWizardInner() {
  const router = useRouter();
  const token = useAppStore((s) => s.token);
  const searchParams = useSearchParams();
  const [step, setStep] = useState<WizardStep>("describe");
  const [description, setDescription] = useState(searchParams.get("desc") ?? "");
  const [session, setSession] = useState<BuildSession | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!token) {
    return (
      <div className="text-center py-20">
        <p style={{ color: "#859399" }}>Please log in first.</p>
        <a href="/login" className="mt-2 inline-block transition-colors hover:underline" style={{ color: "#a4e6ff" }}>Go to Login</a>
      </div>
    );
  }

  async function handleDescribe() {
    if (!description.trim() || !token) return;
    setError(null);
    setLoading(true);
    try {
      const res = await api.buildCompany(token, description);
      setSession(res);
      if (res.status === "ready") {
        setStep("preview");
      } else {
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
    try {
      const res = await api.buildAnswer(token, session.sessionId, answer);
      setSession(res);
      setAnswer("");
      if (res.status === "ready") {
        setStep("preview");
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

  const inputStyle = {
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
    color: "#e1e2eb",
    outline: "none",
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 animate-fade-in">
      <div className="mb-8">
        <h1 className="text-2xl font-bold font-headline" style={{ color: "#e1e2eb" }}>Create AI Company</h1>
        <p className="mt-1" style={{ color: "#859399" }}>Describe your company idea and let AI build it for you.</p>
      </div>

      {/* Progress Steps */}
      <div className="flex items-center mb-8 gap-2">
        {stepKeys.map((s, i) => (
          <div key={s} className="flex items-center">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-all"
              style={{
                background: step === s
                  ? "linear-gradient(135deg, #00d1ff, #6d11ad)"
                  : currentStepIndex > i
                    ? "rgba(52,211,153,0.2)"
                    : "rgba(255,255,255,0.06)",
                border: step === s
                  ? "none"
                  : currentStepIndex > i
                    ? "1px solid rgba(52,211,153,0.3)"
                    : "1px solid rgba(255,255,255,0.08)",
                color: step === s ? "white" : currentStepIndex > i ? "#34d399" : "#859399",
              }}
            >
              {currentStepIndex > i ? "✓" : i + 1}
            </div>
            {i < 3 && (
              <div
                className="w-12 h-0.5 mx-1"
                style={{ background: currentStepIndex > i ? "rgba(52,211,153,0.4)" : "rgba(255,255,255,0.08)" }}
              />
            )}
          </div>
        ))}
      </div>

      {error && (
        <div
          className="px-4 py-3 rounded-xl mb-6 text-sm"
          style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "#f87171" }}
        >
          {error}
          {(error.toLowerCase().includes("limit") || error.toLowerCase().includes("plan")) && (
            <a href="/settings" className="ml-2 underline" style={{ color: "#a4e6ff" }}>Upgrade plan →</a>
          )}
        </div>
      )}

      {/* Step 1: Describe */}
      {step === "describe" && (
        <div className="glass-panel rounded-2xl p-6">
          <h2 className="text-lg font-semibold font-headline mb-3" style={{ color: "#e1e2eb" }}>Describe Your Company</h2>
          <p className="text-sm mb-4" style={{ color: "#859399" }}>
            Tell us what kind of AI company you want to build. Be as detailed as possible —
            what it does, who it serves, which channels it uses.
          </p>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={6}
            className="w-full rounded-xl px-4 py-3 text-sm resize-none transition-all"
            style={inputStyle}
            placeholder="E.g.: I want to build a content agency for Instagram and TikTok. My target market is small businesses. I need AI agents to handle content creation, scheduling, and lead generation..."
            onFocus={(e) => { e.currentTarget.style.border = "1px solid rgba(0,209,255,0.4)"; }}
            onBlur={(e) => { e.currentTarget.style.border = "1px solid rgba(255,255,255,0.08)"; }}
          />
          <button
            onClick={handleDescribe}
            disabled={loading || description.length < 10}
            className="mt-4 w-full text-white py-2.5 rounded-xl font-semibold flex items-center justify-center gap-2 transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)", boxShadow: "0 0 20px rgba(0,209,255,0.2)" }}
          >
            {loading ? (
              <>
                <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                AI is analyzing your idea...
              </>
            ) : "Continue"}
          </button>
          {loading && step === "describe" && (
            <p className="mt-2 text-center text-sm" style={{ color: "#3c494e" }}>
              This may take 15-30 seconds
            </p>
          )}
        </div>
      )}

      {/* Step 2: Clarification */}
      {step === "clarify" && session && (
        <div className="glass-panel rounded-2xl p-6">
          <h2 className="text-lg font-semibold font-headline mb-4" style={{ color: "#e1e2eb" }}>
            Clarification Questions{" "}
            <span style={{ color: "#a4e6ff" }}>(Round {session.turn}/3)</span>
          </h2>

          <div
            className="rounded-xl p-4 mb-4"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
          >
            <p className="text-xs font-semibold tracking-widest mb-2" style={{ color: "#00d1ff" }}>AI COMPANY BUILDER</p>
            <div className="text-sm whitespace-pre-wrap" style={{ color: "#bbc9cf" }}>
              {(() => {
                const raw = typeof session.message === "string" ? session.message : JSON.stringify(session.message, null, 2);
                const stripped = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
                try {
                  const parsed = JSON.parse(stripped);
                  if (parsed.questions && Array.isArray(parsed.questions)) {
                    return (
                      <ol className="list-decimal list-inside space-y-2">
                        {parsed.questions.map((q: string, i: number) => <li key={i}>{q}</li>)}
                      </ol>
                    );
                  }
                  if (parsed.message) return parsed.message;
                  return stripped;
                } catch {
                  return raw;
                }
              })()}
            </div>
          </div>

          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={4}
            className="w-full rounded-xl px-4 py-3 text-sm resize-none transition-all"
            style={inputStyle}
            placeholder="Answer the questions..."
            onFocus={(e) => { e.currentTarget.style.border = "1px solid rgba(0,209,255,0.4)"; }}
            onBlur={(e) => { e.currentTarget.style.border = "1px solid rgba(255,255,255,0.08)"; }}
          />
          <button
            onClick={handleAnswer}
            disabled={loading || answer.length < 1}
            className="mt-4 w-full text-white py-2.5 rounded-xl font-semibold transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}
          >
            {loading ? "Processing..." : "Submit Answer"}
          </button>
        </div>
      )}

      {/* Step 3: Preview */}
      {step === "preview" && session?.companySpec && (
        <div className="glass-panel rounded-2xl p-6">
          <h2 className="text-lg font-semibold font-headline mb-4" style={{ color: "#e1e2eb" }}>Company Preview</h2>

          <div className="space-y-4">
            {[
              { label: "NAME", content: <p className="text-lg font-semibold mt-1" style={{ color: "#e1e2eb" }}>{session.companySpec.name}</p> },
              { label: "DESCRIPTION", content: <p className="text-sm mt-1" style={{ color: "#bbc9cf" }}>{session.companySpec.description}</p> },
            ].map((row) => (
              <div key={row.label}>
                <label className="text-xs font-semibold tracking-widest" style={{ color: "#859399" }}>{row.label}</label>
                {row.content}
              </div>
            ))}
            <div>
              <label className="text-xs font-semibold tracking-widest" style={{ color: "#859399" }}>PRIMITIVES</label>
              <div className="flex flex-wrap gap-2 mt-2">
                {session.companySpec.primitives?.map((p: string) => (
                  <span
                    key={p}
                    className="px-2.5 py-1 text-xs rounded-lg font-semibold"
                    style={{ background: "rgba(0,209,255,0.1)", color: "#a4e6ff", border: "1px solid rgba(0,209,255,0.2)" }}
                  >
                    {p}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold tracking-widest" style={{ color: "#859399" }}>AGENTS ({session.companySpec.agents?.length ?? 0})</label>
              <div className="mt-2 space-y-2">
                {session.companySpec.agents?.map((a: any, i: number) => (
                  <div
                    key={i}
                    className="rounded-xl p-3 text-sm"
                    style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
                  >
                    <span className="font-medium" style={{ color: "#e1e2eb" }}>{a.name}</span>
                    <span className="ml-2" style={{ color: "#859399" }}>({a.role})</span>
                    {a.tools?.length > 0 && (
                      <div className="text-xs mt-1" style={{ color: "#3c494e" }}>Tools: {a.tools.join(", ")}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold tracking-widest" style={{ color: "#859399" }}>PIPELINES ({session.companySpec.pipelines?.length ?? 0})</label>
              <div className="mt-2 space-y-2">
                {session.companySpec.pipelines?.map((p: any, i: number) => (
                  <div
                    key={i}
                    className="rounded-xl p-3 text-sm"
                    style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
                  >
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
                  setSession(null); setDescription(""); setAnswer(""); setError(null); setStep("describe");
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
        <div className="glass-panel rounded-2xl p-12 text-center">
          <div
            className="w-16 h-16 rounded-full border-2 animate-spin mx-auto mb-6"
            style={{ borderColor: "rgba(0,209,255,0.3)", borderTopColor: "#00d1ff" }}
          />
          <p className="text-lg font-semibold font-headline" style={{ color: "#e1e2eb" }}>Building your AI company...</p>
          <p className="text-sm mt-2" style={{ color: "#859399" }}>Setting up agents, pipelines, and tools.</p>
        </div>
      )}

      {/* Step 5: Done */}
      {step === "done" && session && (
        <div className="glass-panel rounded-2xl p-8 text-center">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5"
            style={{ background: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.2)" }}
          >
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
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen" style={{ background: "#10131a" }}><span style={{ color: "#859399" }}>Loading...</span></div>}>
      <CompanyBuilderWizardInner />
    </Suspense>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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

export default function CompanyBuilderWizard() {
  const router = useRouter();
  const token = useAppStore((s) => s.token);
  const [step, setStep] = useState<WizardStep>("describe");
  const [description, setDescription] = useState("");
  const [session, setSession] = useState<BuildSession | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!token) {
    return (
      <div className="text-center py-20">
        <p className="text-slate-500">Please log in first.</p>
        <a href="/login" className="text-brand-400 hover:text-brand-300 mt-2 inline-block transition-colors">Go to Login</a>
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

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 animate-fade-in">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-100">Create AI Company</h1>
        <p className="text-slate-500 mt-1">Describe your company idea and let AI build it for you.</p>
      </div>

      {/* Progress Steps */}
      <div className="flex items-center mb-8 gap-2">
        {stepKeys.map((s, i) => (
          <div key={s} className="flex items-center">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-all ${
                step === s
                  ? "gradient-brand text-white shadow-lg shadow-brand-500/30"
                  : currentStepIndex > i
                    ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                    : "bg-white/[0.06] text-slate-500 border border-white/[0.08]"
              }`}
            >
              {currentStepIndex > i ? "✓" : i + 1}
            </div>
            {i < 3 && <div className={`w-12 h-0.5 mx-1 ${currentStepIndex > i ? "bg-emerald-500/40" : "bg-white/[0.08]"}`} />}
          </div>
        ))}
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl mb-6 text-sm">
          {error}
        </div>
      )}

      {/* Step 1: Describe */}
      {step === "describe" && (
        <div className="card-glass p-6">
          <h2 className="text-lg font-semibold text-slate-200 mb-3">Describe Your Company</h2>
          <p className="text-slate-500 text-sm mb-4">
            Tell us what kind of AI company you want to build. Be as detailed as possible —
            what it does, who it serves, which channels it uses.
          </p>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={6}
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-slate-200 placeholder-slate-600 focus:ring-2 focus:ring-brand-500/50 focus:border-brand-500/50 outline-none resize-none transition-all"
            placeholder="E.g.: Instagram ve TikTok icin icerik ureten bir ajans kurmak istiyorum. Hedef kitlem kucuk isletmeler..."
          />
          <button
            onClick={handleDescribe}
            disabled={loading || description.length < 10}
            className="mt-4 w-full gradient-brand text-white py-2.5 rounded-xl font-semibold hover:shadow-lg hover:shadow-brand-500/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-all"
          >
            {loading ? (
              <>
                <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                AI is analyzing your idea...
              </>
            ) : (
              "Continue"
            )}
          </button>
          {loading && step === "describe" && (
            <p className="mt-2 text-center text-sm text-slate-600 animate-pulse-soft">
              This may take 15-30 seconds
            </p>
          )}
        </div>
      )}

      {/* Step 2: Clarification */}
      {step === "clarify" && session && (
        <div className="card-glass p-6">
          <h2 className="text-lg font-semibold text-slate-200 mb-4">
            Clarification Questions <span className="text-brand-400">(Round {session.turn}/3)</span>
          </h2>

          {/* AI Message */}
          <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 mb-4">
            <p className="text-xs font-semibold text-brand-400 mb-2 uppercase tracking-wide">AI Company Builder</p>
            <div className="text-sm text-slate-300 whitespace-pre-wrap">
              {(() => {
                const raw = typeof session.message === "string" ? session.message : JSON.stringify(session.message, null, 2);
                const stripped = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
                try {
                  const parsed = JSON.parse(stripped);
                  if (parsed.questions && Array.isArray(parsed.questions)) {
                    return (
                      <ol className="list-decimal list-inside space-y-2">
                        {parsed.questions.map((q: string, i: number) => (
                          <li key={i}>{q}</li>
                        ))}
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
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-slate-200 placeholder-slate-600 focus:ring-2 focus:ring-brand-500/50 outline-none resize-none transition-all"
            placeholder="Answer the questions..."
          />
          <button
            onClick={handleAnswer}
            disabled={loading || answer.length < 1}
            className="mt-4 w-full gradient-brand text-white py-2.5 rounded-xl font-semibold hover:shadow-lg hover:shadow-brand-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {loading ? "Processing..." : "Submit Answer"}
          </button>
        </div>
      )}

      {/* Step 3: Preview */}
      {step === "preview" && session?.companySpec && (
        <div className="card-glass p-6">
          <h2 className="text-lg font-semibold text-slate-200 mb-4">Company Preview</h2>

          <div className="space-y-4">
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Name</label>
              <p className="text-lg font-semibold text-slate-100 mt-1">{session.companySpec.name}</p>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Description</label>
              <p className="text-sm text-slate-400 mt-1">{session.companySpec.description}</p>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Primitives</label>
              <div className="flex flex-wrap gap-2 mt-2">
                {session.companySpec.primitives?.map((p: string) => (
                  <span key={p} className="px-2.5 py-1 bg-brand-500/10 text-brand-300 text-xs rounded-lg font-semibold border border-brand-500/20">
                    {p}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Agents ({session.companySpec.agents?.length ?? 0})</label>
              <div className="mt-2 space-y-2">
                {session.companySpec.agents?.map((a: any, i: number) => (
                  <div key={i} className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3 text-sm">
                    <span className="font-medium text-slate-200">{a.name}</span>
                    <span className="text-slate-500 ml-2">({a.role})</span>
                    {a.tools?.length > 0 && (
                      <div className="text-xs text-slate-600 mt-1">
                        Tools: {a.tools.join(", ")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Pipelines ({session.companySpec.pipelines?.length ?? 0})</label>
              <div className="mt-2 space-y-2">
                {session.companySpec.pipelines?.map((p: any, i: number) => (
                  <div key={i} className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3 text-sm">
                    <span className="font-medium text-slate-200">{p.name}</span>
                    <span className="text-slate-500 ml-2">({p.trigger})</span>
                    <div className="text-xs text-slate-600 mt-1">
                      {p.steps?.length ?? 0} steps
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="flex gap-3 mt-6">
            <button
              onClick={() => {
                if (window.confirm("Are you sure? All progress will be lost.")) {
                  setSession(null);
                  setDescription("");
                  setAnswer("");
                  setError(null);
                  setStep("describe");
                }
              }}
              className="flex-1 bg-white/[0.04] border border-white/[0.08] text-slate-400 py-2.5 rounded-xl font-semibold hover:bg-white/[0.07] transition-colors"
            >
              Start Over
            </button>
            <button
              onClick={handleConfirm}
              disabled={loading}
              className="flex-1 gradient-brand text-white py-2.5 rounded-xl font-semibold hover:shadow-lg hover:shadow-brand-500/20 disabled:opacity-50 transition-all"
            >
              {loading ? "Creating..." : "Create Company"}
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Creating */}
      {step === "creating" && (
        <div className="card-glass p-12 text-center">
          <div className="w-16 h-16 rounded-full border-2 border-brand-500/30 border-t-brand-500 animate-spin mx-auto mb-6" />
          <p className="text-lg font-semibold text-slate-200">Building your AI company...</p>
          <p className="text-slate-500 text-sm mt-2">Setting up agents, pipelines, and tools.</p>
        </div>
      )}

      {/* Step 5: Done */}
      {step === "done" && session && (
        <div className="card-glass p-8 text-center">
          <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto mb-5">
            <svg className="w-8 h-8 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
          </div>
          <h2 className="text-2xl font-bold text-slate-100 mb-2">Company Created!</h2>
          <p className="text-slate-500 mb-6">
            {session.companySpec?.name} is ready to go.
          </p>
          <button
            onClick={() => router.push(`/companies`)}
            className="gradient-brand text-white px-6 py-2.5 rounded-xl font-semibold hover:shadow-lg hover:shadow-brand-500/20 transition-all"
          >
            Go to Companies
          </button>
        </div>
      )}
    </div>
  );
}

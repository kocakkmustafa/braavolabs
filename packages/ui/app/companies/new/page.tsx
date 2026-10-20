"use client";

import { Suspense, useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSearchParams } from "next/navigation";
import { api } from "../../../lib/api";
import { consumeOnboardingHandoff } from "../../../lib/onboarding-handoff";
import { useAppStore } from "../../../lib/store";
import { useAuthGuard } from "../../../lib/useAuthGuard";
import StarterPicker from "../../../components/StarterPicker";
import BrandMotion from "../../../components/BrandMotion";
import { wizardMotion } from "../../../lib/brandMotion";
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

/**
 * Idea gallery — pre-written business prompts that seed the freeform
 * builder below and kick off the same AI clarification flow as typing
 * by hand. These are NOT the StarterPicker (which clones a fully-baked
 * Groq-tuned company). These cards just pre-fill the description box and
 * call handleDescribe — the AI composer reads `seed`, runs its 2-3 turn
 * clarification loop, then composes agents across the nine primitives.
 *
 * Labels stay English on purpose: consistent with the existing
 * StarterPicker cards, and i18n for this round is owned elsewhere.
 *
 * `seed` is the plain-English prompt the composer reads — keep each one
 * concrete and grounded in the nine primitives (acquisition / sales /
 * delivery / content / ops / finance / analytics / memory / governance).
 * `agents` / `pipelines` are display-only estimates of what the composer
 * will likely staff, mirroring the StarterPicker card metadata shape.
 */
type IdeaCategory =
  | "Marketing"
  | "Sales"
  | "Content"
  | "Ops"
  | "Research"
  | "Finance"
  | "Support"
  | "Founder";

interface IdeaTemplate {
  id: string;
  emoji: string;
  title: string;
  desc: string;
  category: IdeaCategory;
  /** Plain-English prompt pre-filled into the builder. */
  seed: string;
  /** Display-only estimate of agents the composer will likely staff. */
  agents: number;
  /** Display-only estimate of pipelines the composer will likely build. */
  pipelines: number;
}

const IDEA_CATEGORIES: IdeaCategory[] = [
  "Marketing",
  "Sales",
  "Content",
  "Ops",
  "Research",
  "Finance",
  "Support",
  "Founder",
];

const IDEA_TEMPLATES: IdeaTemplate[] = [
  // ── Content ──────────────────────────────────────────────────
  {
    id: "content-studio",
    emoji: "🎬",
    title: "Content Studio",
    desc: "Spot trends, draft, and polish social posts on autopilot.",
    category: "Content",
    seed: "I run a small brand and want a content studio that publishes consistently. A trend scout should find 2-3 angles trending in my niche, a writer should draft a TikTok and a LinkedIn post for the strongest angle, and an editor should tighten the hook and CTA. Save each as a draft for me to review before posting, and remember which angles performed so future drafts get sharper.",
    agents: 3,
    pipelines: 1,
  },
  {
    id: "content-repurposer",
    emoji: "♻️",
    title: "Content Repurposer",
    desc: "Turn one idea into an X thread, a LinkedIn post, and a newsletter blurb.",
    category: "Content",
    seed: "I want to repurpose one source idea, post, or transcript into a multi-platform pack. A strategist should pick the three strongest angles, then a writer should spin them into an X thread, a LinkedIn post, and a short newsletter blurb — all in my brand voice if it's stored in memory. Save the pack as a draft.",
    agents: 2,
    pipelines: 1,
  },
  {
    id: "seo-content-engine",
    emoji: "🔍",
    title: "SEO Content Engine",
    desc: "Research keywords and outline search-optimized articles.",
    category: "Content",
    seed: "I want an SEO content engine. A researcher should find the search intent and related questions for a target keyword, an outliner should produce an H2/H3 structure with internal-link suggestions, and a writer should draft a search-optimized article around it. Save the brief and draft, and remember which topics I've already covered so we don't repeat ourselves.",
    agents: 3,
    pipelines: 1,
  },
  {
    id: "newsletter-studio",
    emoji: "📰",
    title: "Newsletter Studio",
    desc: "Curate a theme and draft a weekly newsletter issue.",
    category: "Content",
    seed: "I send a weekly newsletter and want help drafting each issue. A curator should pick a theme and gather 3-5 worth-sharing items for my audience, then a writer should draft the issue with a strong subject line, intro, the curated items with one-line takes, and a closing CTA. Save it as a draft and remember past themes so issues stay varied.",
    agents: 2,
    pipelines: 1,
  },
  {
    id: "podcast-repurposer",
    emoji: "🎙️",
    title: "Podcast Repurposer",
    desc: "Turn an episode transcript into show notes and clip-worthy quotes.",
    category: "Content",
    seed: "I host a podcast and want to repurpose each episode. Given a transcript, a producer should write structured show notes with timestamps and key takeaways, and a clip-finder should surface 5-8 quotable moments worth turning into short social clips. Save the notes and the quote list as drafts.",
    agents: 2,
    pipelines: 1,
  },

  // ── Marketing ────────────────────────────────────────────────
  {
    id: "brand-voice-builder",
    emoji: "🎨",
    title: "Brand Voice Builder",
    desc: "Codify your tone into a one-page reference doc.",
    category: "Marketing",
    seed: "I want to codify my brand voice. A brand analyst should extract tone attributes, signature phrases, and phrases to avoid from a description and any sample content I provide, then a style codifier should write a one-page reference with three example posts that demonstrate the voice. Store it in memory under 'brand voice' so my content agents can read it.",
    agents: 2,
    pipelines: 1,
  },
  {
    id: "competitor-watch",
    emoji: "🛰️",
    title: "Competitor Watch",
    desc: "Track rival moves and summarize what changed each week.",
    category: "Marketing",
    seed: "I want to keep an eye on a handful of competitors. A web researcher should scan for recent moves — launches, pricing changes, messaging shifts — across their sites and the web, then an analyst should summarize what changed this week and why it matters for my positioning. Save a short report and remember prior findings so each scan only flags what's new.",
    agents: 2,
    pipelines: 1,
  },
  {
    id: "social-listening",
    emoji: "👂",
    title: "Social Listening",
    desc: "Surface what people are saying about a topic or brand.",
    category: "Marketing",
    seed: "I want social listening on a topic and my brand. A researcher should gather recent public mentions and discussions across the web, then an analyst should cluster them into themes, flag the sentiment, and pull a few representative quotes. Save a digest and store recurring themes in memory so trends become visible over time.",
    agents: 2,
    pipelines: 1,
  },
  {
    id: "webinar-promoter",
    emoji: "📣",
    title: "Webinar Promoter",
    desc: "Plan a promo sequence for an upcoming event.",
    category: "Marketing",
    seed: "I have a webinar coming up and want a promotion plan. A planner should map a multi-touch promo timeline (announce, value teaser, reminder, last-call), then a writer should draft the social posts and emails for each touch in my brand voice. Save everything as drafts for me to schedule manually.",
    agents: 2,
    pipelines: 1,
  },
  {
    id: "ad-creative-tester",
    emoji: "🧪",
    title: "Ad Creative Tester",
    desc: "Generate ad angle variations to test, no spend.",
    category: "Marketing",
    seed: "I want to test ad creative angles before spending. A strategist should propose 4-5 distinct angles (pain, outcome, social-proof, contrarian, curiosity) for my product, then a copywriter should write a headline and primary text variant for each. Save them as drafts so I can paste the winners into my ad platform myself. No ad spend or platform writes.",
    agents: 2,
    pipelines: 1,
  },

  // ── Sales ────────────────────────────────────────────────────
  {
    id: "outreach-strategist",
    emoji: "✉️",
    title: "Outreach Strategist",
    desc: "Sharpen your ICP and draft a cold-email sequence.",
    category: "Sales",
    seed: "I want a cold-outreach engine that drafts but never sends. An ICP researcher should sharpen my ideal customer profile from my product and a target hint, then a pitch writer should produce a three-message sequence — intro, follow-up, and breakup — ready to copy into my inbox. Save the sequence as a draft.",
    agents: 2,
    pipelines: 1,
  },
  {
    id: "cold-outreach-engine",
    emoji: "🚀",
    title: "Cold Outreach Engine",
    desc: "Personalize first-touch emails for a target list.",
    category: "Sales",
    seed: "I have a list of target accounts and want personalized first-touch emails. A researcher should pull a relevant hook for each prospect from public info, then a writer should draft a short, specific opener referencing that hook with one clear CTA. Save drafts for me to review and send manually, and log every draft. No automatic sending.",
    agents: 2,
    pipelines: 1,
  },
  {
    id: "lead-qualifier",
    emoji: "✅",
    title: "Lead Qualifier",
    desc: "Score inbound leads against your ICP and route them.",
    category: "Sales",
    seed: "I want to qualify inbound leads. Given a lead's details, an analyst should score fit against my ICP (industry, size, role, intent signals) and a router should recommend an action — fast-track, nurture, or disqualify — with a one-line reason. Log every decision and remember scoring patterns so qualification gets more consistent over time.",
    agents: 2,
    pipelines: 1,
  },
  {
    id: "proposal-writer",
    emoji: "📄",
    title: "Proposal Writer",
    desc: "Turn a project brief into a client-ready proposal.",
    category: "Sales",
    seed: "I want to turn a project brief into a client proposal. A scoper should sharpen the client context, problem, success metrics, and scope boundaries, then a writer should draft a structured proposal — summary, scope, deliverables, phased timeline, and value-framed pricing. Save it as a draft for me to review and send.",
    agents: 2,
    pipelines: 1,
  },
  {
    id: "partnership-outreach",
    emoji: "🤝",
    title: "Partnership Outreach",
    desc: "Find fitting partners and draft intro pitches.",
    category: "Sales",
    seed: "I want to line up partnership conversations. A researcher should identify the kinds of companies that complement my product and find a few concrete candidates, then a writer should draft a tailored intro pitch for each that leads with the mutual win. Save the pitches as drafts for me to send manually.",
    agents: 2,
    pipelines: 1,
  },

  // ── Research ─────────────────────────────────────────────────
  {
    id: "market-research",
    emoji: "📊",
    title: "Market Research Agent",
    desc: "Scan a market and synthesize a one-page report.",
    category: "Research",
    seed: "I want a fast market scan. A web researcher should gather signals across 5-10 high-signal sources about my market, then a synthesizer should produce a one-page report covering market size signals, the top three competitors with a one-line distinction each, 12-month trends, and the opportunity. Save the report and store key findings in memory so future scans build on them.",
    agents: 2,
    pipelines: 1,
  },

  // ── Ops ──────────────────────────────────────────────────────
  {
    id: "customer-onboarding",
    emoji: "🧭",
    title: "Customer Onboarding",
    desc: "Draft a guided welcome sequence for new customers.",
    category: "Ops",
    seed: "I want to onboard new customers smoothly. A planner should map a milestone-based onboarding journey (welcome, setup, first value, check-in), then a writer should draft the message for each milestone in my brand voice. Save the sequence as drafts I can send manually, and remember the journey so every new customer gets the same guided start.",
    agents: 2,
    pipelines: 1,
  },
  {
    id: "churn-watch",
    emoji: "📉",
    title: "Churn Watch",
    desc: "Flag at-risk accounts and draft win-back outreach.",
    category: "Ops",
    seed: "I want to catch churn early. Given account activity I provide, an analyst should flag at-risk accounts with the warning signs and a reason, then a writer should draft a tailored win-back message for each flagged account. Save drafts for me to review, log every assessment, and remember which signals tend to precede churn.",
    agents: 2,
    pipelines: 1,
  },
  {
    id: "product-launch-kit",
    emoji: "🎁",
    title: "Product Launch Kit",
    desc: "Assemble launch messaging and a go-live checklist.",
    category: "Ops",
    seed: "I'm launching a product and want a launch kit. A strategist should draft the core positioning and key messages, a writer should produce the announcement assets (landing copy, social posts, launch email), and an ops agent should assemble a go-live checklist. Save everything as drafts and keep the checklist in memory so nothing slips.",
    agents: 3,
    pipelines: 1,
  },

  // ── Finance ──────────────────────────────────────────────────
  {
    id: "invoice-chaser",
    emoji: "🧾",
    title: "Invoice Chaser",
    desc: "Draft polite, escalating payment reminders.",
    category: "Finance",
    seed: "I want help chasing overdue invoices. Given a list of outstanding invoices I provide, an agent should draft a polite, escalating reminder for each (gentle nudge, firm follow-up, final notice) referencing the amount and due date. Save the reminders as drafts for me to send manually, and log every draft. Never send anything automatically and never move money.",
    agents: 1,
    pipelines: 1,
  },
  {
    id: "weekly-finance-digest",
    emoji: "💹",
    title: "Weekly Finance Digest",
    desc: "Summarize the numbers I track into a weekly readout.",
    category: "Finance",
    seed: "I want a weekly finance digest. Given the figures I provide (revenue, spend, runway, key metrics), an analyst should compare them to the prior period, call out what moved and why it matters, and flag anything that needs attention. Save a short readout and remember prior weeks so the digest shows trends. Read-only — no transactions.",
    agents: 1,
    pipelines: 1,
  },

  // ── Support ──────────────────────────────────────────────────
  {
    id: "support-triage",
    emoji: "🎫",
    title: "Support Triage",
    desc: "Categorize tickets and draft first replies.",
    category: "Support",
    seed: "I want to triage incoming support tickets. Given a ticket, an agent should categorize it (bug, billing, how-to, feature request), set a priority, and draft a helpful first reply grounded in my knowledge base. Save the draft for a human to review before sending, log every triage decision, and remember recurring issues so common answers improve.",
    agents: 2,
    pipelines: 1,
  },
  {
    id: "review-responder",
    emoji: "⭐",
    title: "Review Responder",
    desc: "Draft on-brand replies to customer reviews.",
    category: "Support",
    seed: "I want help responding to customer reviews. Given a review, an agent should gauge the sentiment and draft a thoughtful, on-brand reply — gracious for praise, accountable and solution-oriented for complaints. Save replies as drafts for me to post, and remember recurring praise and complaints so I can spot patterns.",
    agents: 1,
    pipelines: 1,
  },

  // ── Founder ──────────────────────────────────────────────────
  {
    id: "recruiting-sourcer",
    emoji: "🧑‍💼",
    title: "Recruiting Sourcer",
    desc: "Draft a role profile and personalized candidate outreach.",
    category: "Founder",
    seed: "I'm hiring and want sourcing help. A recruiter agent should turn a role into a sharp candidate profile (must-haves, signals, where they hang out), then a writer should draft a warm, personalized outreach message I can send to promising candidates. Save drafts for me to send manually and log every one. No automatic messaging.",
    agents: 2,
    pipelines: 1,
  },
];

function CompanyBuilderWizardInner({ owner }: { owner: { tenantId: string | null; revision: number } }) {
  const router = useRouter();
  const { token, hydrated } = useAuthGuard();
  const t = useTranslations();
  const searchParams = useSearchParams();
  const [step, setStep] = useState<WizardStep>("describe");
  const [description, setDescription] = useState(() => {
    try { const handoff = consumeOnboardingHandoff(sessionStorage, owner); if (handoff) return handoff; } catch { /* storage unavailable */ }
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
  const [ideaCategory, setIdeaCategory] = useState<IdeaCategory | "All">("All");

  const visibleIdeas =
    ideaCategory === "All"
      ? IDEA_TEMPLATES
      : IDEA_TEMPLATES.filter((tpl) => tpl.category === ideaCategory);

  function seedFromIdea(idea: IdeaTemplate) {
    if (loading) return;
    setTouched(true);
    // Pass the seed explicitly so the build kicks off this tick rather
    // than waiting for the description state to flush (see handleDescribe).
    handleDescribe(idea.seed);
  }

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

  async function handleDescribe(override?: string) {
    if (!token) return;
    // `override` lets a template card seed + submit in one tick — React
    // state updates are async, so we can't rely on `description` having
    // settled to the seeded value by the time this runs.
    const prompt = (override ?? description).trim();
    if (!prompt) {
      setError(t("app.companyNew.errDescribe"));
      return;
    }
    if (override) setDescription(override);
    setError(null);
    setLoading(true);

    // Add user message to chat
    setChatHistory((prev) => [...prev, { role: "user", content: prompt, timestamp: new Date() }]);

    try {
      const res = await api.buildCompany(token, prompt);
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
        <div className="flex justify-center mb-3">
          <BrandMotion state={wizardMotion({ step, busy: loading, error, session })} size={56} />
        </div>
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

          {/* ── Idea gallery — seeds the builder + runs the AI flow ── */}
          <div className="mb-6">
            <div className="flex items-end justify-between mb-3 px-1">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: "#a4e6ff" }}>
                  Start from an idea
                </h2>
                <p className="text-xs mt-0.5" style={{ color: "#859399" }}>
                  Pick a starting point — we&apos;ll pre-fill the brief below and the AI will tailor it to you.
                </p>
              </div>
            </div>

            {/* Category filter pills — reuse FORGE .bv-fpill */}
            <div className="flex flex-wrap gap-2 mb-4 px-1" role="tablist" aria-label="Template categories">
              <button
                type="button"
                role="tab"
                aria-selected={ideaCategory === "All"}
                className={`bv-fpill${ideaCategory === "All" ? " active" : ""}`}
                onClick={() => setIdeaCategory("All")}
              >
                All
                <span className="bv-fpill-count">{IDEA_TEMPLATES.length}</span>
              </button>
              {IDEA_CATEGORIES.map((cat) => {
                const count = IDEA_TEMPLATES.filter((tpl) => tpl.category === cat).length;
                if (count === 0) return null;
                return (
                  <button
                    key={cat}
                    type="button"
                    role="tab"
                    aria-selected={ideaCategory === cat}
                    className={`bv-fpill${ideaCategory === cat ? " active" : ""}`}
                    onClick={() => setIdeaCategory(cat)}
                  >
                    {cat}
                    <span className="bv-fpill-count">{count}</span>
                  </button>
                );
              })}
            </div>

            {/* Idea cards — same metadata shape as StarterPicker */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {visibleIdeas.map((idea) => (
                <button
                  key={idea.id}
                  type="button"
                  disabled={loading}
                  onClick={() => seedFromIdea(idea)}
                  className="text-left rounded-2xl p-4 transition-all hover:brightness-110 disabled:opacity-60 disabled:cursor-wait"
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.08)",
                  }}
                  aria-label={`Start from idea: ${idea.title}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-2xl leading-none">{idea.emoji}</div>
                    <span className="bv-pill bv-pill-muted">{idea.category}</span>
                  </div>

                  <div className="mt-3 font-semibold text-sm" style={{ color: "#e1e2eb" }}>
                    {idea.title}
                  </div>
                  <div className="mt-1 text-xs leading-relaxed" style={{ color: "#bbc9cf" }}>
                    {idea.desc}
                  </div>

                  <div className="mt-3 flex items-center gap-3 text-[11px]" style={{ color: "#859399" }}>
                    <span title={`${idea.agents} agents`}>
                      <span className="material-symbols-outlined align-middle" style={{ fontSize: 12 }}>
                        person
                      </span>{" "}
                      {idea.agents}
                    </span>
                    <span title={`${idea.pipelines} pipeline`}>
                      <span className="material-symbols-outlined align-middle" style={{ fontSize: 12 }}>
                        account_tree
                      </span>{" "}
                      {idea.pipelines}
                    </span>
                  </div>

                  <div className="mt-3 text-[11px] flex items-center gap-1" style={{ color: "#60A5FA" }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 13 }}>auto_awesome</span>
                    Use this idea
                  </div>
                </button>
              ))}
            </div>

            <div className="text-center mt-4">
              <span className="text-[11px] uppercase tracking-wide" style={{ color: "#3c494e" }}>
                or describe your own below ↓
              </span>
            </div>
          </div>

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
  const { token, hydrated } = useAuthGuard();
  const tenantId = useAppStore(state => state.tenantId);
  const revision = useAppStore(state => state.sessionRevision);
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
      {hydrated && token && tenantId ? <CompanyBuilderWizardInner key={revision} owner={{ tenantId, revision }} /> : null}
    </Suspense>
  );
}

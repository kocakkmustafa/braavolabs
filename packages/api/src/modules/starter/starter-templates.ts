/**
 * Free-tier starter company catalog — pre-baked Company + Agent +
 * Pipeline definitions that a new tenant can spin up in one click and
 * immediately try with their 3 trial Groq runs.
 *
 * Why hand-written instead of AI-composed?
 *   The Trial Groq path runs on llama-3.3-70b-versatile. It's competent
 *   but more brittle than Claude on long-context reasoning, so we pre-
 *   tune the system prompts here (concise, single-responsibility, no
 *   nested tool chains) to maximize the probability that the user's
 *   FIRST run succeeds — the highest-leverage moment for activation.
 *
 *   Once a user is on a paid plan or BYOK, freeform creation is the
 *   normal path; this catalog is purely a launch-friction reduction.
 *
 * Hard constraints when adding new templates:
 *   1. NO tool that requires an external API key (HubSpot, SendGrid,
 *      social APIs, image-gen, ad-spend). Trial users haven't connected
 *      anything yet — every tool call must work with the platform alone.
 *   2. ≤ 3 agents per template. Llama on 70B + concurrency = 200 K input
 *      tokens chewed in one pipeline run if we're not careful.
 *   3. ≤ 3 pipeline steps. Same reason.
 *   4. System prompts ≤ 600 characters each. Helps the smaller model.
 *   5. The pipeline must produce a useful output without ANY tool that
 *      writes to the outside world (so failed integrations never break
 *      the demo).
 *
 * Adding a template? Run `pnpm test` — the schema integrity test
 * (starter-templates.test.ts) catches structural drift early.
 */
import { z } from "zod";

// Tool names below MUST exist in packages/api/src/modules/agent/registry.ts.
// Keep this list narrow — see "Hard constraints" above.
const SAFE_TOOLS = [
  "analyze_trends",
  "recall_memory",
  "store_memory",
  "consolidate_memories",
  "generate_post",
  "content_generate",
  "content_generate_image_prompt",
  "create_draft",
  "generate_brand_voice",
  "generate_icp",
  "generate_content_strategy",
  "generate_outreach_pitch",
  "generate_report",
  "compare_performance",
  "fetch_metrics",
  "web_search",
  "knowledge_base_search",
  "proposal_generate",
] as const;
export type SafeTool = (typeof SAFE_TOOLS)[number];
export const SAFE_TOOL_SET: ReadonlySet<string> = new Set(SAFE_TOOLS);

const PRIMITIVES = [
  "ACQUISITION",
  "SALES",
  "DELIVERY",
  "CONTENT",
  "OPERATIONS",
  "FINANCE",
  "ANALYTICS",
  "MEMORY",
  "GOVERNANCE",
] as const;
type Primitive = (typeof PRIMITIVES)[number];

export const StarterAgentSchema = z.object({
  name: z.string().min(2).max(60),
  role: z.string().min(2).max(60),
  systemPrompt: z.string().min(40).max(600),
  tools: z.array(z.string()).min(1).max(6),
});

export const StarterStepSchema = z.object({
  name: z.string().min(2).max(80),
  agentRole: z.string().min(2).max(60),
  order: z.number().int().min(0).max(10),
  config: z.record(z.string(), z.unknown()).optional(),
  readMemoryKeys: z.array(z.string()).optional(),
  writeMemoryKey: z.string().optional(),
});

export const StarterPipelineSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(240).optional(),
  steps: z.array(StarterStepSchema).min(1).max(3),
});

export const StarterTemplateSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "use kebab-case"),
  name: z.string().min(3).max(60),
  tagline: z.string().min(8).max(120),
  description: z.string().min(40).max(400),
  emoji: z.string().min(1).max(8), // lucide / emoji glyph for the picker card
  primitives: z.array(z.enum(PRIMITIVES)).min(1).max(5),
  agents: z.array(StarterAgentSchema).min(1).max(3),
  pipelines: z.array(StarterPipelineSchema).min(1).max(2),
  /** Display-only: 1-line "what does it do" hook for the picker. */
  outcome: z.string().min(10).max(140),
  /** Display-only: rough estimate of how many of the 3 trial runs the
   *  template eats per useful output. Used to set expectations on the
   *  picker card. Pure UI hint — not enforced server-side. */
  trialCost: z.number().int().min(1).max(3),
});

export type StarterTemplate = z.infer<typeof StarterTemplateSchema>;

// ─── The catalog ─────────────────────────────────────────────────
// Keep the list small + high-signal. The picker grid is responsive
// (grid-cols-1 / sm:2 / lg:4), so the current 6 cards reflow cleanly
// (4 + 2 at lg). Mind the Groq-friendly constraints above for any add.

export const STARTER_TEMPLATES: StarterTemplate[] = [
  // ─── 1. Content Studio ───────────────────────────────────────
  // Hero company per CLAUDE.md. 3 agents, 3-step pipeline. Produces a
  // ready-to-publish post draft for TikTok + LinkedIn given a topic.
  {
    id: "content-studio",
    name: "Content Studio",
    tagline: "TikTok + LinkedIn posts on autopilot",
    emoji: "🎬",
    description:
      "A 3-agent content team: a trend scout finds what's hot in your niche, a writer drafts the post, and an editor polishes the hook + CTA. Output is a publish-ready draft you can edit before posting.",
    outcome: "1 polished social post draft per run",
    trialCost: 1,
    primitives: ["CONTENT", "ANALYTICS", "MEMORY"],
    agents: [
      {
        name: "Trend Scout",
        role: "trend_scout",
        systemPrompt:
          "You are a social-media trend researcher. Given a topic, identify 2–3 angles that are trending right now (use analyze_trends + recall_memory). Return a short JSON-style list of {angle, why_it_works}. Be concise. No fluff.",
        tools: ["analyze_trends", "recall_memory", "web_search"],
      },
      {
        name: "Content Writer",
        role: "content_writer",
        systemPrompt:
          "You are a punchy social-media copywriter. Given trending angles, write ONE short post (≤180 chars for TikTok, ≤2200 chars for LinkedIn) per platform. Hook first sentence, clear CTA last sentence. Use generate_post.",
        tools: ["generate_post", "content_generate"],
      },
      {
        name: "Editor",
        role: "editor",
        systemPrompt:
          "You polish drafts. Tighten hooks, remove cliché phrases (\"in today's fast-paced world\", \"game-changing\"), strengthen CTAs. Return the final post. Use create_draft to persist.",
        tools: ["create_draft", "store_memory"],
      },
    ],
    pipelines: [
      {
        name: "Daily Post",
        description: "Scout trends → write → polish → save as draft.",
        steps: [
          { name: "Find trends", agentRole: "trend_scout", order: 0, writeMemoryKey: "trends" },
          { name: "Write post", agentRole: "content_writer", order: 1, readMemoryKeys: ["trends"], writeMemoryKey: "raw_post" },
          { name: "Polish + save", agentRole: "editor", order: 2, readMemoryKeys: ["raw_post"] },
        ],
      },
    ],
  },

  // ─── 2. Outreach Strategist ──────────────────────────────────
  // Drafts cold-outreach without sending. User reviews, copies, sends
  // manually (or upgrades to wire SendGrid). Two agents keep latency low.
  {
    id: "outreach-strategist",
    name: "Outreach Strategist",
    tagline: "Cold-email drafts tailored to your ICP",
    emoji: "✉️",
    description:
      "Pair an ICP researcher with a pitch writer. Describe your product and target, get back a 3-message outreach sequence (intro, follow-up, breakup) ready to copy-paste into your inbox.",
    outcome: "3-step email sequence draft",
    trialCost: 1,
    primitives: ["SALES", "CONTENT", "MEMORY"],
    agents: [
      {
        name: "ICP Researcher",
        role: "icp_researcher",
        systemPrompt:
          "Define a sharp ideal customer profile. Inputs: product description + target hint. Output: {industry, role, pain_points, trigger_events}. Use generate_icp + recall_memory. Be specific — \"VP of Sales at Series-B SaaS, 50–200 employees, just raised\" beats \"sales leaders at growing companies\".",
        tools: ["generate_icp", "recall_memory", "web_search"],
      },
      {
        name: "Pitch Writer",
        role: "pitch_writer",
        systemPrompt:
          "You write 3-message cold-email sequences. Based on the ICP: intro (60 words, single CTA), follow-up (40 words, value reframe), breakup (20 words, low-pressure). No \"I hope this finds you well\". Use generate_outreach_pitch + create_draft.",
        tools: ["generate_outreach_pitch", "create_draft", "store_memory"],
      },
    ],
    pipelines: [
      {
        name: "Outreach Draft",
        description: "Sharpen ICP → write sequence → save as draft.",
        steps: [
          { name: "Define ICP", agentRole: "icp_researcher", order: 0, writeMemoryKey: "icp" },
          { name: "Write sequence", agentRole: "pitch_writer", order: 1, readMemoryKeys: ["icp"] },
        ],
      },
    ],
  },

  // ─── 3. Market Research Agent ────────────────────────────────
  // Useful for indie founders + product managers wanting fast competitor
  // intel. web_search + synthesizer pattern.
  {
    id: "market-research",
    name: "Market Research Agent",
    tagline: "Competitor + market scan, synthesized",
    emoji: "📊",
    description:
      "A web researcher gathers signals across 5–10 sources, then a synthesizer summarizes the landscape, the top 3 competitors, and the likely 1-year direction. Output is a 1-page report.",
    outcome: "1-page market scan report",
    trialCost: 1,
    primitives: ["ANALYTICS", "MEMORY", "OPERATIONS"],
    agents: [
      {
        name: "Web Researcher",
        role: "web_researcher",
        systemPrompt:
          "Gather signals about a market or topic. Use web_search aggressively; aim for 5–10 high-signal sources. Output a flat list of {source, claim, evidence}. Do NOT synthesize — just collect. Use knowledge_base_search to surface anything we already know.",
        tools: ["web_search", "knowledge_base_search", "recall_memory"],
      },
      {
        name: "Synthesizer",
        role: "synthesizer",
        systemPrompt:
          "Turn raw research into a 1-page market scan. Sections: market size (signal), top 3 competitors (with 1-line distinction each), 12-month trends (3 bullets), opportunity (1 paragraph). Use generate_report. Persist key findings to store_memory so future runs can build on them.",
        tools: ["generate_report", "store_memory", "consolidate_memories"],
      },
    ],
    pipelines: [
      {
        name: "Market Scan",
        description: "Collect web signals → synthesize 1-page report.",
        steps: [
          { name: "Collect signals", agentRole: "web_researcher", order: 0, writeMemoryKey: "research" },
          { name: "Synthesize report", agentRole: "synthesizer", order: 1, readMemoryKeys: ["research"] },
        ],
      },
    ],
  },

  // ─── 4. Brand Voice Builder ──────────────────────────────────
  // Foundational — produces a brand voice doc that can later be referenced
  // by Content Studio and Outreach Strategist via shared memory.
  {
    id: "brand-voice-builder",
    name: "Brand Voice Builder",
    tagline: "Codify your brand's tone in one run",
    emoji: "🎨",
    description:
      "Two agents extract your brand's voice from sample content (or a description), then codify it as a 1-page reference: tone words, signature phrases, things you NEVER say, and 3 example posts.",
    outcome: "1-page brand voice doc",
    trialCost: 1,
    primitives: ["CONTENT", "MEMORY", "ANALYTICS"],
    agents: [
      {
        name: "Brand Analyst",
        role: "brand_analyst",
        systemPrompt:
          "Extract a brand's voice. Input: brand description + 1–3 sample texts (if provided). Output: {tone_attributes (5), signature_phrases (3), avoid_phrases (3)}. Use generate_brand_voice + recall_memory. Be opinionated — \"witty but never sarcastic\" beats \"professional and friendly\".",
        tools: ["generate_brand_voice", "recall_memory"],
      },
      {
        name: "Style Codifier",
        role: "style_codifier",
        systemPrompt:
          "Turn a voice analysis into a 1-page reference doc. Add a section with 3 example posts (Twitter/X, LinkedIn, blog headline) that demonstrate the voice in action. Persist via store_memory under key \"brand_voice\" so other companies can read it. Use generate_content_strategy + create_draft.",
        tools: ["generate_content_strategy", "create_draft", "store_memory"],
      },
    ],
    pipelines: [
      {
        name: "Voice Codification",
        description: "Analyze samples → produce 1-page voice doc.",
        steps: [
          { name: "Analyze voice", agentRole: "brand_analyst", order: 0, writeMemoryKey: "voice" },
          { name: "Codify doc", agentRole: "style_codifier", order: 1, readMemoryKeys: ["voice"] },
        ],
      },
    ],
  },

  // ─── 5. Proposal Writer ──────────────────────────────────────
  // Sales/delivery. Turns a plain client+work description into a
  // structured proposal draft. Exercises proposal_generate. Works with
  // zero external data — pure description-in, draft-out.
  {
    id: "proposal-writer",
    name: "Proposal Writer",
    tagline: "Turn a project brief into a client proposal",
    emoji: "📄",
    description:
      "Describe the client and the work; a scoper sharpens the offer and a writer drafts a structured proposal — summary, scope, deliverables, timeline, and value-framed pricing — ready to review and send.",
    outcome: "1 client proposal draft",
    trialCost: 1,
    primitives: ["SALES", "DELIVERY", "MEMORY"],
    agents: [
      {
        name: "Scoper",
        role: "scoper",
        systemPrompt:
          "Sharpen a client engagement. Inputs: client + work description. Output: {client_context, problem, success_metrics, scope_boundaries}. Use generate_icp to frame the buyer and recall_memory for any prior context. Be concrete — name deliverables, not vague \"solutions\".",
        tools: ["generate_icp", "recall_memory", "web_search"],
      },
      {
        name: "Proposal Writer",
        role: "proposal_writer",
        systemPrompt:
          "Write a structured client proposal from the scope. Sections: Summary, Scope, Deliverables, Timeline (phased), Investment (value-framed, ranges OK). Professional, confident, no jargon padding. Use proposal_generate, then create_draft to save.",
        tools: ["proposal_generate", "create_draft", "store_memory"],
      },
    ],
    pipelines: [
      {
        name: "Proposal Draft",
        description: "Scope the engagement → write proposal → save as draft.",
        steps: [
          { name: "Scope engagement", agentRole: "scoper", order: 0, writeMemoryKey: "scope" },
          { name: "Write proposal", agentRole: "proposal_writer", order: 1, readMemoryKeys: ["scope"] },
        ],
      },
    ],
  },

  // ─── 6. Content Repurposer ───────────────────────────────────
  // One source idea/post → a multi-format pack (X thread, LinkedIn,
  // newsletter). Distinct from Content Studio (which finds trends and
  // writes ONE post). Reads brand_voice from memory if present.
  {
    id: "content-repurposer",
    name: "Content Repurposer",
    tagline: "One idea → a multi-platform content pack",
    emoji: "♻️",
    description:
      "Give it one idea, post, or transcript; a strategist picks the strongest angles and a writer spins them into a pack — an X thread, a LinkedIn post, and a short newsletter blurb — all in your brand voice.",
    outcome: "3-format content pack draft",
    trialCost: 1,
    primitives: ["CONTENT", "MEMORY", "ANALYTICS"],
    agents: [
      {
        name: "Repurpose Strategist",
        role: "repurpose_strategist",
        systemPrompt:
          "Given one source idea or post, pick the 3 strongest angles to repurpose. Consider what travels on each format (X = punchy/threaded, LinkedIn = story + lesson, newsletter = useful + skimmable). Output {angle, format, hook} ×3. Use recall_memory for brand_voice if present.",
        tools: ["content_generate", "recall_memory", "analyze_trends"],
      },
      {
        name: "Multi-format Writer",
        role: "multiformat_writer",
        systemPrompt:
          "Write the 3 pieces from the angles: an X thread (5–7 tweets), a LinkedIn post (≤1500 chars, story → lesson → CTA), and a newsletter blurb (≤120 words). Match the brand voice if provided. Use generate_post + content_generate, then create_draft to save the pack.",
        tools: ["generate_post", "content_generate", "create_draft"],
      },
    ],
    pipelines: [
      {
        name: "Repurpose Pack",
        description: "Pick angles → write 3 formats → save as draft.",
        steps: [
          { name: "Pick angles", agentRole: "repurpose_strategist", order: 0, writeMemoryKey: "angles" },
          { name: "Write pack", agentRole: "multiformat_writer", order: 1, readMemoryKeys: ["angles"] },
        ],
      },
    ],
  },
];

/** Look up a template by id. Throws if not found — callers should
 * validate the id with `STARTER_TEMPLATE_IDS` first if 404 vs 500
 * matters. */
export function getStarterTemplate(id: string): StarterTemplate {
  const t = STARTER_TEMPLATES.find((x) => x.id === id);
  if (!t) {
    throw new Error(
      `Unknown starter template "${id}". Known: ${STARTER_TEMPLATES.map((x) => x.id).join(", ")}`,
    );
  }
  return t;
}

export const STARTER_TEMPLATE_IDS = STARTER_TEMPLATES.map((t) => t.id);

/** Generate a slug-safe, time-stamped variant of the template id so a
 * tenant can clone the same template multiple times without colliding
 * on the unique (tenantId, slug) constraint. */
export function deriveCompanySlug(template: StarterTemplate, attempt = 0): string {
  const base = template.id;
  if (attempt === 0) return base;
  return `${base}-${attempt + 1}`;
}

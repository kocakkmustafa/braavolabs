/**
 * Docs content — The Manual.
 *
 * Single source of truth for the docs index (app/docs/page.tsx) and the
 * docs article pages (app/docs/[slug]/page.tsx). Content is expressed as a
 * typed block array (no HTML injection — the renderer maps each block to a
 * plain React node), so every page is statically generated and type-checked.
 *
 * Content rule: every product claim here is grounded in the codebase
 * (CLAUDE.md product context, governance engine, agent loop, BYOK router,
 * webhook router, license/export DRM, plan constants) and in app/blog/posts.ts.
 * No invented features, customers, metrics or benchmarks. English-first.
 */

export type DocCategory = "Start here" | "Concepts" | "Reference";

/** A single Q&A — used by the FAQ block and to emit FAQPage JSON-LD. */
export interface FaqItem {
  q: string;
  a: string;
}

/**
 * Typed content blocks. The renderer in [slug]/page.tsx exhaustively switches
 * on `kind` — adding a block kind without a renderer arm is a type error.
 */
export type DocBlock =
  | { kind: "heading"; id: string; text: string }
  | { kind: "para"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "steps"; items: { title: string; body: string }[] }
  | { kind: "code"; lang?: string; caption?: string; code: string }
  | { kind: "note"; tone: "info" | "warn"; text: string }
  | { kind: "faq"; items: FaqItem[] };

export interface DocPage {
  slug: string;
  title: string;
  /** Short label for the index card + side nav. */
  nav: string;
  category: DocCategory;
  /** Used for the index card blurb and the page <meta description>. */
  desc: string;
  /** Material Symbols icon name for the index card + header. */
  icon: string;
  /** Reading order across the whole manual (drives prev/next + index order). */
  order: number;
  blocks: DocBlock[];
}

/** Category → pill class (shared by index cards + article header). */
export const DOC_PILL: Record<DocCategory, string> = {
  "Start here": "bv-pill bv-pill-cyan",
  Concepts: "bv-pill bv-pill-purple",
  Reference: "bv-pill bv-pill-amber",
};

/* ─────────────────────────────────────────────────────────────────────────
 * Pages — ordered by `order`.
 * ──────────────────────────────────────────────────────────────────────── */

export const DOCS: DocPage[] = [
  // 1 ── Getting started ────────────────────────────────────────────────────
  {
    slug: "getting-started",
    title: "Getting started",
    nav: "Getting started",
    category: "Start here",
    icon: "rocket_launch",
    order: 1,
    desc: "Braavolabs is a cross-vendor AI workbench and control plane for governed runs, approvals, and explicit model and data-mode choice.",
    blocks: [
      {
        kind: "para",
        text: "Braavolabs is a cross-vendor AI workbench and control plane. It coordinates governed model and agent work while keeping model choice, approval, and data mode explicit. This page introduces that product contract without promising unfinished release capabilities.",
      },
      {
        kind: "heading",
        id: "the-first-run",
        text: "The first run, step by step",
      },
      {
        kind: "steps",
        items: [
          {
            title: "Create an account",
            body: "Create an account with email, Google, or GitHub on the authenticated app surface.",
          },
          {
            title: "Describe your business",
            body: "Type what you want the company to do, in your own words: \"A content studio that drafts and schedules LinkedIn and TikTok posts for ten clients,\" or \"An outbound team that qualifies inbound leads and books demos.\" Plain language is the input — you are not wiring nodes.",
          },
          {
            title: "Answer the clarifying questions",
            body: "Before composing anything, Braavolabs runs a short two-to-three-turn clarification loop. It asks the few things it genuinely needs — your audience, your tone, the channels you care about — instead of guessing and getting them wrong.",
          },
          {
            title: "Review the composed agents and pipeline",
            body: "Braavolabs proposes a set of agents spread across the nine primitives (acquisition, sales, delivery, content, operations, finance, analytics, memory, governance) and a pipeline that orders their work. Read it, rename things, drop steps you do not want. Nothing runs until you say so.",
          },
          {
            title: "Run it",
            body: "Start the pipeline. Each step records its reasoning before it acts, every tool call is logged, and spend accrues step by step so you always see the running cost.",
          },
          {
            title: "Approve spend and answer ask_user",
            body: "Any money-touching action pauses for an explicit approval. If an agent hits genuine ambiguity, it can call ask_user and park the run with a question — both land in the same approvals queue, so there is one place to look.",
          },
          {
            title: "Watch the live run",
            body: "Follow the run as it executes: steps, status, accumulating cost, and the reasoning behind each move. You can steer it mid-flight or stop it at any time.",
          },
        ],
      },
      {
        kind: "heading",
        id: "plans-and-inference",
        text: "Plans and inference",
      },
      {
        kind: "para",
        text: "Individual — $19/month. Team — $39/active-user/month.",
      },
      {
        kind: "para",
        text: "Inference is not included. Use your own provider keys (BYOK) or local models.",
      },
      {
        kind: "note",
        tone: "info",
        text: "Holding — premium/private preview. Signed evidence — in development.",
      },
      {
        kind: "note",
        tone: "info",
        text: "Authoring — composing agents, designing pipelines, wiring integrations — happens on the web. The companion mobile app is for command: monitor, approve, answer, and steer from anywhere. See the Mobile app page.",
      },
      {
        kind: "heading",
        id: "where-to-go-next",
        text: "Where to go next",
      },
      {
        kind: "list",
        items: [
          "Concepts — the vocabulary: workspaces, agents, pipelines, runs, the nine primitives, approvals, the five risk-stops, and the audit trail.",
          "BYOK & providers — add a provider key or select a local runtime.",
          "Mid-run steering & ask_user — redirect a run in flight without re-running it.",
          "Webhooks — let external events trigger your pipelines, signed and verified.",
        ],
      },
    ],
  },

  // 2 ── Concepts ─────────────────────────────────────────────────────────────
  {
    slug: "concepts",
    title: "Core concepts",
    nav: "Concepts",
    category: "Concepts",
    icon: "schema",
    order: 2,
    desc: "The vocabulary: workspaces, agents, pipelines, runs, the nine primitives, approvals, the five risk-stops, and the audit trail.",
    blocks: [
      {
        kind: "para",
        text: "A handful of nouns explain almost everything in Braavolabs. Learn these and the rest of the product reads cleanly.",
      },
      {
        kind: "heading",
        id: "workspaces",
        text: "Workspaces (companies)",
      },
      {
        kind: "para",
        text: "A workspace — also called a company — is one autonomous AI company: a named set of agents, the pipelines that orchestrate them, and the memory, contacts, and run history they accumulate. You can run several workspaces side by side, and each can be paused or resumed as a whole. Every workspace is tenant-isolated: its data never bleeds into another.",
      },
      {
        kind: "heading",
        id: "agents",
        text: "Agents",
      },
      {
        kind: "para",
        text: "An agent is a role with a job — \"acquisition,\" \"sales,\" \"content,\" and so on. Braavolabs staffs your workspace by composing agents across the nine primitives below, each scoped to the tools it needs. Agents do not act on impulse; they act as steps inside a pipeline, and every step they take records its reasoning before the action.",
      },
      {
        kind: "heading",
        id: "the-nine-primitives",
        text: "The nine primitives",
      },
      {
        kind: "para",
        text: "Every agent maps to one of nine primitives — the functional building blocks a company is made of. Composition picks the ones your business needs and leaves the rest out.",
      },
      {
        kind: "list",
        items: [
          "Acquisition — finding and qualifying net-new prospects or audiences.",
          "Sales — outreach, follow-up, and moving deals forward.",
          "Delivery — producing and shipping the actual work.",
          "Content — drafting and scheduling posts, copy, and creative.",
          "Operations — the glue steps that keep a pipeline coherent.",
          "Finance — invoices, reconciliation, and money-side reporting.",
          "Analytics — measuring what happened and surfacing it.",
          "Memory — episodic, semantic, and graph memory the company learns from.",
          "Governance — the agent that enforces approvals and the risk-stops.",
        ],
      },
      {
        kind: "heading",
        id: "pipelines",
        text: "Pipelines",
      },
      {
        kind: "para",
        text: "A pipeline is the ordered plan that puts agents to work — the sequence of steps that turns intent into output. You review and edit the composed pipeline before the first run, and you can re-run, roll back, or re-run individual steps afterward. Pipelines are written against the platform, not against any one model vendor, so changing models never means rewriting a pipeline.",
      },
      {
        kind: "heading",
        id: "runs",
        text: "Runs",
      },
      {
        kind: "para",
        text: "A run is one execution of a pipeline. It streams live — steps, status, and accumulating cost update as it goes — and every run is fully reconstructable afterward from its steps. A run can be steered while it executes, paused on a question, resumed safely, or stopped outright. Runs are the unit you watch, govern, and audit.",
      },
      {
        kind: "heading",
        id: "approvals",
        text: "Approvals",
      },
      {
        kind: "para",
        text: "No money-touching action runs without an explicit approval attached to it. Spend requests land in the approvals queue; you approve, edit, or reject them, and the run continues from there. The same queue carries an agent's ask_user questions as an input-type approval — one gate to check instead of two. Every decision, yours or an agent's, is recorded.",
      },
      {
        kind: "heading",
        id: "the-five-risk-stops",
        text: "The five risk-stops",
      },
      {
        kind: "para",
        text: "Five named checks run between the steps of every run and can halt it on the spot. They ship enabled by default — opt-in safety is decorative safety — and when one fires, the run stops, the reason is written to the audit trail in plain language, and you are notified.",
      },
      {
        kind: "list",
        items: [
          "Hard stop — an unconditional veto. Flag a run for a hard stop and it takes no further step. There is always one switch that wins.",
          "Loop guard — five consecutive failed steps halt the pipeline. Five in a row is a pattern, not noise, and retrying just grinds budget into the same wall.",
          "Cost-anomaly stop — a run tracking more than 20% over its budget halts mid-execution, while there is still something left to save.",
          "Spam guard — three unanswered sends to the same recipient stop the sequence. Persistence past silence costs reputation and earns nothing.",
          "Brand-violation stop — generated drafts and posts are scanned against a conservative blocklist (defamation-adjacent framing, get-rich-quick or guaranteed-return claims, hate-speech markers, adult content) before they ship. Coverage is multilingual — English and Turkish today.",
        ],
      },
      {
        kind: "heading",
        id: "the-audit-trail",
        text: "The audit trail",
      },
      {
        kind: "para",
        text: "Everything an agent does leaves a record designed to be read, not just stored. Four invariants hold across the platform and are enforced in code: every tool call is logged with its inputs, outputs, and timing; every step carries a required reasoning field, written at decision time; every spend has an approval row; and the activity log captures every other create, update, send, and decision — including the governance engine's own interventions. When a risk-stop fires, the entry says which stop, what it observed, and the numbers behind it.",
      },
    ],
  },

  // 3 ── BYOK & providers ──────────────────────────────────────────────────────
  {
    slug: "byok-and-providers",
    title: "BYOK & providers",
    nav: "BYOK & providers",
    category: "Reference",
    icon: "vpn_key",
    order: 3,
    desc: "Bring your own keys or select a local runtime, and understand how provider routing and data-mode consent work.",
    blocks: [
      {
        kind: "para",
        text: "Braavolabs is bring-your-own-key. You connect the model providers you want, and the platform routes each step through them. Your pipelines are written against the router, not a vendor SDK, so swapping providers is a settings change — no pipeline definitions touched, no prompts rewritten.",
      },
      {
        kind: "heading",
        id: "fourteen-providers",
        text: "Provider routes",
      },
      {
        kind: "para",
        text: "The router resolves the cloud-provider or local-model route the operator configured:",
      },
      {
        kind: "list",
        items: [
          "Cloud routes use provider credentials supplied by the operator.",
          "Local routes can use Ollama, LM Studio, or a custom OpenAI-compatible endpoint.",
        ],
      },
      {
        kind: "heading",
        id: "add-a-key",
        text: "Adding a key",
      },
      {
        kind: "steps",
        items: [
          {
            title: "Open Settings → AI Provider",
            body: "Find the provider you want to connect in the AI Provider settings.",
          },
          {
            title: "Paste your API key",
            body: "Enter the key from that provider's own dashboard. The platform resolves the provider you explicitly selected for the run.",
          },
          {
            title: "Pick models per step",
            body: "Mix freely: a strong reasoning model where judgment matters, a fast cheap model for extraction and glue steps, a local model where data is sensitive. The router makes the mix a per-workspace configuration choice, and every choice is reversible.",
          },
        ],
      },
      {
        kind: "note",
        tone: "warn",
        text: "If no key or local runtime resolves, a run must fail loudly with a clear configuration error rather than silently switching to a model you did not choose.",
      },
      {
        kind: "heading",
        id: "how-keys-are-stored",
        text: "How your keys are stored",
      },
      {
        kind: "para",
        text: "A provider key is among the most sensitive things you can hand a platform, so it is encrypted with AES-256-GCM — authenticated encryption, with a per-row derived key — before it is stored. The plaintext is never returned by the API afterward: the dashboard can tell you a key exists, but it cannot show it back to you, and neither can anyone who gets a copy of a database dump.",
      },
      {
        kind: "heading",
        id: "local-runtime",
        text: "Running locally",
      },
      {
        kind: "para",
        text: "Ollama, LM Studio, and custom OpenAI-compatible endpoints can provide a local model route. Availability, model download, hardware fit, and quality remain the operator's responsibility; the public contract does not promise a bundled local model.",
      },
      {
        kind: "para",
        text: "Switching to local inference changes nothing else: the agent loop is identical, tool calls are still logged, every step still records its reasoning, spends still wait for approvals, and all five risk-stops still run between steps. Governance lives in the pipeline layer, not in any model vendor's cloud, so it travels with you to the edge.",
      },
      {
        kind: "heading",
        id: "data-sharing-consent",
        text: "AI data-sharing consent",
      },
      {
        kind: "para",
        text: "Sending data to a model provider is a choice you make explicitly. When you connect a cloud provider, you consent to your run inputs being sent to that provider for inference under their terms — which is what BYOK means in practice. If your work cannot leave the building, route the sensitive steps to a local provider instead; consent and routing are per-workspace, and you can keep judgment-heavy steps local and everything else wherever you like.",
      },
    ],
  },

  // 4 ── Mid-run steering & ask_user ───────────────────────────────────────────
  {
    slug: "mid-run-steering",
    title: "Mid-run steering & ask_user",
    nav: "Steering & ask_user",
    category: "Concepts",
    icon: "alt_route",
    order: 4,
    desc: "Redirect a running pipeline without re-running it, and let agents pause to ask you a question — with resume that never double-bills.",
    blocks: [
      {
        kind: "para",
        text: "A multi-step run is a working session, not a cassette tape. Most platforms give you two buttons for a run that has gone off course: let it finish, or kill it and start over. Braavolabs gives you a third option — lean over its shoulder and redirect it, mid-flight, without burning everything it already did.",
      },
      {
        kind: "heading",
        id: "steering-a-run",
        text: "Steering a running pipeline",
      },
      {
        kind: "para",
        text: "A live run accepts instructions. Type into the steer box — on the web dashboard or the phone app — and your instruction is persisted as a steering message attached to the run. At each turn boundary, before the agent takes its next action, the loop drains the queued steering messages, marks them consumed, and injects them into the working context as explicit operator guidance. The model sees your words for what they are: a human redirecting the work. The live event stream then confirms the steering was applied, so you are never left wondering whether your message landed.",
      },
      {
        kind: "heading",
        id: "why-turn-boundaries",
        text: "Why turn boundaries",
      },
      {
        kind: "para",
        text: "Braavolabs deliberately does not interrupt the model mid-step. A turn boundary is the one point where the world is consistent: the previous tool call has fully resolved and been logged, cost accounting is up to date, and the conversation state is valid. Injecting guidance there means the agent always reacts to your instruction with a clean picture of what it has already done — and because agent turns are short, the next boundary is never far away.",
      },
      {
        kind: "heading",
        id: "ask-user",
        text: "ask_user: steering in reverse",
      },
      {
        kind: "para",
        text: "Steering handles the case where you spot the problem. The ask_user tool handles the case where the agent does. When a run hits genuine ambiguity — two plausible readings of a brief, a missing detail that should not be guessed — the agent can stop and ask. The run parks in a waiting state, the question lands as an input approval in the same queue that gates spending, and a push notification routes you straight to the answer form. Your answer comes back into the run through the same channel steering uses, tagged as a human-in-the-loop answer. One pause primitive, two directions: operator interrupts agent, agent interrupts operator.",
      },
      {
        kind: "heading",
        id: "idempotent-resume",
        text: "Resuming without double-billing",
      },
      {
        kind: "para",
        text: "Pausing is only useful if resuming is safe, and resuming is only safe if it is idempotent. When a paused run resumes, the runner walks the plan from the top but skips every step that already completed — restoring each one's persisted output instead of executing it again. Emails do not send twice. Approved spends do not repeat. And the cost already incurred is seeded into the resumed run's accounting, so budget governance sees true cumulative spend rather than a fresh zero. Nothing double-bills, and no risk-stop gets blindsided by a counter reset.",
      },
      {
        kind: "note",
        tone: "info",
        text: "Because resume is idempotent, the cost-anomaly stop cannot be gamed by pausing — a resumed run keeps counting from where it left off.",
      },
    ],
  },

  // 5 ── Webhooks ─────────────────────────────────────────────────────────────
  {
    slug: "webhooks",
    title: "Webhooks",
    nav: "Webhooks",
    category: "Reference",
    icon: "webhook",
    order: 5,
    desc: "Trigger your pipelines from external events with signed, verified, replay-protected webhooks.",
    blocks: [
      {
        kind: "para",
        text: "Webhooks let external systems trigger work inside a Braavolabs workspace. An inbound event — a new order, a form submission, a CRM change — fans in to your workspace and can kick off a pipeline. Because anything that can trigger autonomous work is security-sensitive, every webhook is signed, timestamped, and replay-protected.",
      },
      {
        kind: "heading",
        id: "the-endpoint",
        text: "The endpoint",
      },
      {
        kind: "para",
        text: "Inbound webhooks are addressed per workspace and per event type:",
      },
      {
        kind: "code",
        lang: "text",
        caption: "Endpoint shape",
        code: "POST /hooks/<workspace>/<event>",
      },
      {
        kind: "para",
        text: "<workspace> is your workspace (company) slug; <event> is the event name your pipeline listens for. The path tells Braavolabs both who the event belongs to and what it is.",
      },
      {
        kind: "heading",
        id: "signing",
        text: "Signing and verification",
      },
      {
        kind: "para",
        text: "Each request is authenticated with an HMAC-SHA256 signature over the payload, computed with your workspace's webhook secret. A timestamp is required on every request, and Braavolabs enforces a 5-minute replay window: a request whose timestamp is older than five minutes is rejected, so a captured request cannot be replayed later.",
      },
      {
        kind: "list",
        items: [
          "Compute the HMAC-SHA256 of the request body using your webhook signing secret.",
          "Send the hex digest in the signature header, and the request time in the timestamp header.",
          "Requests with a missing, malformed, or stale timestamp — or a signature that does not match — are rejected before any pipeline runs.",
        ],
      },
      {
        kind: "heading",
        id: "sample-request",
        text: "A sample signed request",
      },
      {
        kind: "code",
        lang: "bash",
        caption: "Signing and sending a webhook with curl",
        code: `# Your workspace webhook secret (from Settings) and the event payload.
SECRET="whsec_your_workspace_secret"
BODY='{"order_id":"1042","total":"149.99"}'
TS=$(date +%s)

# HMAC-SHA256 of the raw body, hex-encoded.
SIG=$(printf '%s' "$BODY" \\
  | openssl dgst -sha256 -hmac "$SECRET" \\
  | sed 's/^.* //')

curl -X POST https://api.braavolabs.com/hooks/acme-content/order_created \\
  -H "Content-Type: application/json" \\
  -H "X-Braavo-Timestamp: $TS" \\
  -H "X-Braavo-Signature: $SIG" \\
  -d "$BODY"`,
      },
      {
        kind: "note",
        tone: "warn",
        text: "Sign the exact raw bytes you send, not a re-serialized copy — any whitespace or key-ordering difference changes the HMAC and the request will be rejected. Send the timestamp you signed with, and send it promptly: outside the 5-minute window the request is treated as a replay.",
      },
    ],
  },

  // 6 ── Connecting external automations ───────────────────────────────────────
  {
    slug: "external-automations",
    title: "Connecting external automations",
    nav: "External automations",
    category: "Reference",
    icon: "hub",
    order: 6,
    desc: "Monitor the n8n, Make, and Zapier automations you already run, alongside your Braavolabs pipelines.",
    blocks: [
      {
        kind: "para",
        text: "You almost certainly already run automations elsewhere. Braavolabs is built to be the command center for the agents and automations you already have — not a walled garden that demands you rebuild them. The Connections surface lets you bring those external automations into view next to your Braavolabs pipelines.",
      },
      {
        kind: "heading",
        id: "what-you-connect",
        text: "What you connect",
      },
      {
        kind: "para",
        text: "Connect the automation tools you run today — n8n, Make, and Zapier — so their activity shows up in one place. The point is unification: a single pane where your owned automations and your Braavolabs workspaces sit side by side, rather than scattered across browser tabs.",
      },
      {
        kind: "heading",
        id: "what-is-shown",
        text: "What's shown",
      },
      {
        kind: "list",
        items: [
          "The connection itself — which external tool is linked and its status.",
          "Activity from those automations surfaced in your Connections view, so you can monitor what they are doing without leaving Braavolabs.",
          "Your Braavolabs pipelines alongside them, so monitoring is genuinely one screen.",
        ],
      },
      {
        kind: "note",
        tone: "info",
        text: "Braavolabs competes on control, mobility, privacy, and price — not on connector count. Connections are about giving you one place to watch and steer what you already run, not about replacing the tools you like.",
      },
    ],
  },

  // 7 ── Mobile app ───────────────────────────────────────────────────────────
  {
    slug: "mobile-app",
    title: "Mobile app",
    nav: "Mobile app",
    category: "Reference",
    icon: "smartphone",
    order: 7,
    desc: "The companion app puts the command seat in your pocket — monitor, approve, answer, and steer — while authoring stays on the web.",
    blocks: [
      {
        kind: "para",
        text: "Agents do not keep office hours. The run that needs a decision can fire at 21:40, when you are nowhere near a desk — and if the only place you can act is a desktop dashboard, \"human in the loop\" degrades into \"human who finds out tomorrow.\" So Braavolabs splits the product along the line where your attention actually splits: authoring on the web, command in your pocket.",
      },
      {
        kind: "heading",
        id: "four-verbs",
        text: "Four verbs, not a shrunken dashboard",
      },
      {
        kind: "para",
        text: "The companion app is built around the four things that genuinely cannot wait — each a two-minute interaction:",
      },
      {
        kind: "steps",
        items: [
          {
            title: "Monitor",
            body: "Watch live runs with their steps, status, and accumulating cost, polled while you watch.",
          },
          {
            title: "Approve",
            body: "Clear the spend-approval queue, because money-touching actions in Braavolabs always wait for an explicit yes.",
          },
          {
            title: "Answer",
            body: "When an agent calls ask_user, the question arrives as a form you can fill on the spot, and the run resumes with your answer injected.",
          },
          {
            title: "Steer",
            body: "Type a correction into the steer box on the live run view; the agent picks it up at its next turn boundary, mid-run, no restart.",
          },
        ],
      },
      {
        kind: "heading",
        id: "notifications",
        text: "Notifications that land where the decision is",
      },
      {
        kind: "para",
        text: "Push notifications carry the moments that matter — an approval waiting, an agent asking a question, a risk-stop halting a run — and each deep-links to the exact surface where you act. An ask_user notification opens the run detail where the answer form lives, not a generic list you have to dig through. Risk alerts default to on, because a cost anomaly or a runaway loop is precisely what you want to know about while away from your desk.",
      },
      {
        kind: "heading",
        id: "security",
        text: "Security without ceremony",
      },
      {
        kind: "para",
        text: "A phone that can approve spending and redirect agents is a credential. The current client uses hardware-backed secure storage for auth tokens and the authenticated session contract used by the app. Supported mobile actions are intended to write into the shared activity model; signed, independently verifiable evidence remains in development.",
      },
      {
        kind: "note",
        tone: "info",
        text: "Authoring — composing agents, designing pipelines, wiring integrations — stays on the web, where big screens and keyboards earn their keep. The pocket is where you keep your hand on the wheel.",
      },
    ],
  },

  // 8 ── FAQ ──────────────────────────────────────────────────────────────────
  {
    slug: "faq",
    title: "Frequently asked questions",
    nav: "FAQ",
    category: "Start here",
    icon: "quiz",
    order: 8,
    desc: "Honest, direct answers to the questions people — and AI assistants — ask most about Braavolabs.",
    blocks: [
      {
        kind: "para",
        text: "Short, honest answers to the questions we hear most. If yours is not here, the support page has a human on the other end.",
      },
      {
        kind: "faq",
        items: [
          {
            q: "Is Braavolabs an alternative to Zapier or n8n?",
            a: "Not exactly — it is a different shape of tool. Zapier and n8n wire deterministic triggers to actions; Braavolabs composes and runs autonomous AI agents that reason through multi-step work. In fact Braavolabs is designed to sit alongside them: you can connect your existing n8n, Make, and Zapier automations and monitor them from one place rather than replace them.",
          },
          {
            q: "Can I run my AI agents from my phone?",
            a: "Yes. The companion mobile app lets you monitor live runs, approve spending, answer an agent's ask_user question, and steer a run mid-flight — from anywhere. Authoring (composing agents and designing pipelines) stays on the web where the screen space helps, but command fits in your pocket.",
          },
          {
            q: "Do I pay per task?",
            a: "No per-task inference is bundled. Individual is $19/month and Team is $39/active-user/month. Inference is not included; use your own provider keys or local models.",
          },
          {
            q: "What models can I use?",
            a: "Use a supported cloud route with credentials you supply, or a configured local route such as Ollama, LM Studio, or a custom OpenAI-compatible endpoint. Available routes are shown in settings and are not represented here as a fixed provider count.",
          },
          {
            q: "Is my data private?",
            a: "Your provider keys are encrypted with AES-256-GCM and never shown back to you after you save them. Because Braavolabs is bring-your-own-key, your run data goes to the providers you choose, under their terms — and you consent to that explicitly. A local model route changes the inference endpoint; verify the selected data mode, tools, telemetry, and network boundary separately.",
          },
          {
            q: "Can it run offline?",
            a: "A configured local runtime can serve supported models without using a cloud-provider key. Availability and data handling depend on the runtime and route you select; no offline bundle capability is claimed here.",
          },
          {
            q: "How is this different from a generic automation tool?",
            a: "Generic tools automate fixed steps; Braavolabs runs reasoning agents you can govern. Every step records why it acted, every spend waits for your approval, and five risk-stops (hard, loop, cost, spam, brand) halt runaway behavior by default. You can steer a run mid-flight, an agent can pause to ask you a question, and everything is captured in an audit trail built to be read. The difference is governed autonomy, not just more connectors.",
          },
        ],
      },
    ],
  },
];

export function getDoc(slug: string): DocPage | undefined {
  return DOCS.find((d) => d.slug === slug);
}

/** Ordered list used by the index, the side nav, and prev/next links. */
export const DOCS_ORDERED: DocPage[] = [...DOCS].sort((a, b) => a.order - b.order);

/** Extract every FAQ item on a page (for FAQPage JSON-LD). */
export function faqItemsOf(page: DocPage): FaqItem[] {
  return page.blocks.flatMap((b) => (b.kind === "faq" ? b.items : []));
}

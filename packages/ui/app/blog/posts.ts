/**
 * Blog posts — The Forge Log.
 *
 * Single source of truth for the blog index (app/blog/page.tsx) and the
 * article pages (app/blog/[slug]/page.tsx). Bodies are markdown-ish strings
 * rendered by the tiny renderer in the article page: "## " lines become
 * headings, "- " lines become bullets, blank-line-separated blocks become
 * paragraphs. No HTML is ever injected.
 *
 * Content rule: every product claim in these articles is grounded in the
 * codebase (governance engine, agent loop, webhook router, BYOK router,
 * license/export DRM, plan constants). No invented customers, metrics or
 * benchmarks.
 */

export type BlogCategory = "Product" | "Engineering" | "Governance" | "Field notes";

export interface BlogPost {
  slug: string;
  title: string;
  category: BlogCategory;
  date: string;
  read: string;
  desc: string;
  body: string;
}

/** Shared category → pill class mapping (index cards + article header). */
export const CATEGORY_PILL: Record<BlogCategory, string> = {
  Product: "bv-pill bv-pill-cyan",
  Engineering: "bv-pill bv-pill-purple",
  Governance: "bv-pill bv-pill-amber",
  "Field notes": "bv-pill bv-pill-muted",
};

/** Newest first. POSTS[0] is the featured post on the index. */
export const POSTS: BlogPost[] = [
  {
    slug: "steer-agents-mid-run",
    title: "Why we steer agents mid-run instead of re-running them",
    category: "Product",
    date: "Jun 2, 2026",
    read: "7 min",
    desc: "Re-running a failed agent wastes tokens and time. We built mid-run steering and ask_user so you redirect a run in flight — here's the architecture behind it.",
    body: `
Every agent platform demos the same happy path: type a goal, watch the run, applaud. Nobody demos minute eleven — the moment the agent has misread the brief and is now confidently producing the wrong thing while your budget ticks down. On most platforms you get exactly two buttons for that moment: let it finish, or kill it and start over.

We think both buttons are wrong. A multi-step run is a working session, not a cassette tape. You should be able to lean over its shoulder and say "not that customer, this one" without burning everything it already did.

## The re-run tax

Kill a run at step seven of twelve and you don't just discard the bad step — you discard the six good ones before it. Re-running means paying for those steps again, waiting for them again, and hoping the agent makes the same good decisions twice. Multi-step agents are valuable precisely because they accumulate context as they work; throwing that context away is the single most expensive thing you can do with one.

The tax gets worse as pipelines get longer. The deeper your automation, the more a restart costs, which quietly pressures you to keep pipelines shallow. That's backwards. The platform should make depth safe.

## Steering is a write, not a wish

In Braavolabs, a live run accepts instructions. You type into a steer box — on the web dashboard or the phone app — and that instruction is persisted as a steering message attached to the run.

The agent loop does the rest. At every turn boundary, before the agent takes its next action, the loop drains whatever steering messages have queued up, marks them consumed, and injects them into the working context as explicit operator guidance. The model sees your words framed as what they are: a human redirecting the work, mid-flight. The run's live event stream then confirms the steering was applied, so you're never left wondering whether your message landed.

## Why turn boundaries

We deliberately don't interrupt the model mid-step. A turn boundary is the one point where the world is consistent: the previous tool call has fully resolved and been logged, cost accounting is up to date, and the conversation state is valid. Injecting guidance there means the agent always reacts to your instruction with a clean picture of what it has already done — and because agent turns are short, the next boundary is never far away. You get responsiveness without corrupting a tool call in progress.

## ask_user: steering in reverse

Steering handles the case where you spot the problem. The ask_user tool handles the case where the agent does. When a run hits genuine ambiguity — two plausible interpretations of a brief, a missing detail that shouldn't be guessed — the agent can stop and ask. The run parks in a waiting state, the question lands as an input approval in the same queue that gates spending, and a push notification routes you straight to the answer form. Your answer comes back into the run through the same channel steering uses, tagged as a human-in-the-loop answer.

One pause primitive, two directions: operator interrupts agent, agent interrupts operator.

## Resuming without double-billing

Pausing is only useful if resuming is safe, and resuming is only safe if it's idempotent. When a paused run resumes, the runner walks the plan from the top but skips every step that already completed — restoring each one's persisted output instead of executing it again. Emails don't send twice. Approved spends don't repeat. And the cost already incurred is seeded into the resumed run's accounting, so budget governance sees true cumulative spend rather than a fresh zero. Nothing double-bills, and no risk stop gets blindsided by a counter reset.

That guarantee is what makes the whole feature trustworthy. People only pause runs freely when resuming costs nothing and risks nothing.

## What this changes

Once you can redirect a run in flight, your relationship with autonomy changes. You stop writing paranoid, over-specified prompts that try to anticipate every fork, because you know you can correct course live. You let pipelines run longer and deeper, because depth no longer multiplies the cost of a mistake. The agent does the work; you keep the wheel.

Try Braavolabs free and steer your first run mid-flight — no card, no re-runs.
`,
  },
  {
    slug: "five-risk-stops-explained",
    title: "The five risk-stops, explained",
    category: "Governance",
    date: "May 28, 2026",
    read: "6 min",
    desc: "Hard, loop, cost, spam and brand — how each stop fires and why they default on.",
    body: `
Autonomy is easy to demo and hard to trust. The difference is brakes. Braavolabs runs five named risk-stops as part of its governance engine — checks that execute between the steps of every run and can halt execution on the spot. They ship enabled by default, and when one fires, the run stops, the reason is written to the activity log in plain language, and a push notification tells you what happened and why.

Here is each one, and the failure it exists to catch.

## 1. The hard stop

The simplest stop and the most important: an unconditional veto. When a run is flagged for a hard stop — by you, or by system policy — the governance check sees the flag and refuses to let the run take another step. There's no negotiation and no condition to evaluate. Every autonomous system needs one switch that always wins, and this is ours.

## 2. The loop guard

Agents fail like software but retry like people: stubbornly. The loop guard watches the run's step history, and five consecutive failed steps halt the pipeline automatically. One failure is noise. Five in a row is a pattern — usually a broken assumption upstream that no amount of retrying will fix — and every additional retry just grinds budget into the same wall. The guard stops the grinding and hands the situation back to you with the failure trail intact.

## 3. The cost-anomaly stop

Every run carries a budget, and spend accrues step by step as the run executes. The cost-anomaly stop compares live spend against that budget and halts a run that is tracking more than 20% over it — mid-execution, not in a report the next morning. Because the check runs between steps, the overrun is caught while there's still something left to save. And because resumed runs seed their previously incurred cost instead of resetting to zero, the stop can't be gamed by pausing.

## 4. The spam guard

Outreach is where autonomous mistakes become public. The spam guard counts the run's logged send actions — email, message, outreach — grouped by recipient, and three unanswered sends to the same target stop the sequence. Persistence is not a virtue when the other side has gone quiet; past that point, every additional message costs you domain reputation and goodwill while earning nothing. The guard enforces the etiquette a careful human would keep on a good day, on every day.

## 5. The brand-violation stop

Before generated content ships, the engine scans recent drafts and posts against a deliberately conservative set of blocked patterns: defamation-adjacent framing, get-rich-quick and guaranteed-return claims, hate-speech markers, adult content. Coverage is multilingual — English and Turkish today — because brand damage doesn't care which language it ships in.

Conservative means false positives happen, and that's a trade we make consciously: a false positive pauses a run you can review and resume through the approval flow; a false negative publishes something with your name on it. One of those is recoverable.

## Why defaults matter

All five stops are on by default because opt-in safety is decorative safety. The runs that need brakes most are the ones nobody thought to configure — the quick experiment, the pipeline cloned from a template at midnight. Defaults are the only governance that covers those.

And every stop leaves evidence. Each halt writes the stop type, the human-readable reason, and the supporting details to the audit trail, so "why did this run stop?" always has an answer you can read.

Try Braavolabs free — every run ships with all five brakes on.
`,
  },
  {
    slug: "byok-routing-12-providers",
    title: "BYOK: routing 12 providers without lock-in",
    category: "Engineering",
    date: "May 21, 2026",
    read: "9 min",
    desc: "The router that lets each step pick the best model — and swap it without touching your pipeline.",
    body: `
The model market reshuffles itself every few months. A provider that leads on reasoning today gets undercut on price tomorrow; a model that didn't exist last quarter becomes the obvious choice for summarization. If your automation platform hard-wires you to one vendor, every one of those shifts is someone else's pricing decision landing on your bill.

We built Braavolabs the other way around: bring your own keys, and let the platform route.

## Twelve providers, one wire

The router speaks to twelve providers: Anthropic, OpenAI, Google, Mistral, Groq, OpenRouter, DeepSeek, Kimi, Qwen — and on the local side, Ollama, LM Studio, and any custom OpenAI-compatible endpoint you point it at. Cloud or local, hosted or self-run, they all sit behind the same abstraction.

That abstraction is the point. Your pipelines are written against the router, not against a vendor SDK. Swapping providers is a settings change, not a migration: no pipeline definitions touched, no prompts rewritten, no redeploy. When the market moves, you move with it in one screen.

## How a run finds its model

When a run starts, the router resolves credentials in a fixed order. First, your own key — BYOK is always preferred. If you haven't added one yet and you're on the free tier, your first three runs route through a platform-owned Groq pool, so you can watch real pipelines execute before pasting a single key. A trial run is only consumed when it succeeds — a failure inside the loop doesn't burn one of your three. And if nothing resolves, the run fails loudly with a clear "add a key in settings" error instead of silently degrading to some model you didn't choose.

That last behavior is deliberate. Silent model substitution is how platforms quietly trade your output quality for their margin. We'd rather fail with an instruction than succeed with a surprise.

## What happens to your keys

A provider key is among the most sensitive things you can hand a platform, so we treat it accordingly. Keys are encrypted with AES-256-GCM before they're stored — authenticated encryption, per-row derived keys — and the plaintext is never returned by the API afterwards. The dashboard can tell you a key exists; it cannot show it back to you, and neither can anyone who gets a copy of a database dump.

## The local escape hatch

Three of the twelve providers never leave your machine. Ollama and LM Studio expose local models — Gemma, Llama, Qwen and friends — through the same OpenAI-compatible wire format the cloud providers use, so the router treats your laptop like any other endpoint. The custom provider covers anything else that speaks that protocol, including servers inside your own network. Zero token cost, zero data egress, same pipelines. We wrote up the fully-offline setup separately, but the headline is: lock-in isn't just avoidable across vendors, it's avoidable across the cloud boundary entirely.

## The economics of not metering you

BYOK changes the business model, and we think the change is honest. Braavolabs charges flat tiers — free, then $19, $39, and $99 a month — and your token spend happens on your own keys, at provider cost, visible in your own provider dashboard. We don't mark up tokens and we don't meter per task.

Per-task pricing deserves a moment of attention, because it's the dominant model in automation and it quietly punishes exactly the behavior agents are good at. A multi-step agent might take dozens of small steps to do one piece of real work; charge per step or per task, and the bill scales with the agent's thoroughness rather than with the value delivered. The incentive lands on you to keep automations shallow. Flat platform fee plus at-cost tokens points the incentive the right way: deeper pipelines cost us nothing extra, so nothing in our pricing nudges you to cripple them.

## Routing as strategy, not plumbing

The practical pattern we see is mixing: a strong reasoning model where judgment matters, a fast cheap model for extraction and glue steps, a local model where the data is sensitive. The router makes that a per-company configuration decision instead of an architecture decision — and keeps every one of those choices reversible.

Vendors will keep leapfrogging each other. That's good for you, but only if switching costs stay near zero. Keeping them near zero is the router's whole job.

Try Braavolabs free — your first three runs are on us, then your keys, your models, your call.
`,
  },
  {
    slug: "pocket-steering",
    title: "Pocket-steering: command from your phone",
    category: "Product",
    date: "May 14, 2026",
    read: "5 min",
    desc: "Authoring stays on the web; control fits in your pocket. The mobile architecture.",
    body: `
Agents don't keep office hours. The run that needs a decision fires at 21:40, when you're nowhere near a desk — and if the only place you can act is a desktop dashboard, "human in the loop" degrades into "human who finds out tomorrow."

So we split the product along the line where your attention actually splits. Authoring — composing agents, designing pipelines, wiring integrations — stays on the web, where big screens and keyboards earn their keep. Command goes mobile: a companion app whose entire job is to let you read, approve, answer, and steer from wherever you are.

## Four verbs, not a shrunken dashboard

The tempting mistake was to squeeze the whole dashboard onto a phone. We didn't. The app is built around the four things that genuinely can't wait:

- Read — live runs with their steps, status, and accumulating cost, polled while you watch.
- Approve — the spend-approval queue, because money-touching actions in Braavolabs always wait for an explicit yes.
- Answer — when an agent calls ask_user, the question arrives as a form you can fill on the spot, and the run resumes with your answer injected.
- Steer — a steer box on the live run view. Type a correction, and the agent picks it up at its next turn boundary, mid-run, no restart.

Everything on that list is a two-minute interaction. Everything not on that list belongs on the web.

## Notifications that land where the decision is

Push notifications carry the moments that matter: an approval waiting, an agent asking a question, a risk-stop halting a run. Each one deep-links to the exact surface where you act — an ask_user notification opens the run detail where the answer form lives, not a generic list you have to dig through. Risk alerts default to on, because a cost anomaly or a runaway loop is precisely the thing you want to know about while away from your desk.

## Security without ceremony

A phone that can approve spending and redirect agents is a credential, so we treat the token storage seriously. Auth tokens live in SecureStore — the device's hardware-backed keychain — not in any storage that syncs or backs up off the device. Sessions ride the same JWT-plus-rotating-refresh scheme as the web app. Nothing about going mobile loosens the security model; the phone is a first-class, fully-audited client, and every action you take from it lands in the same activity log as everything else.

## Why this split works

Mid-run steering changed what a phone could be worth. Before it, a mobile app for an agent platform was a read-only status widget — nice, optional. Once a run can accept guidance in flight and pause on a question, the phone becomes the difference between an agent waiting twelve minutes for you versus twelve hours. The web is where you build the machine. The pocket is where you keep your hand on it.

Try Braavolabs free, then put the command seat in your pocket.
`,
  },
  {
    slug: "offline-on-device-gemma",
    title: "Running fully offline with on-device Gemma",
    category: "Engineering",
    date: "May 7, 2026",
    read: "8 min",
    desc: "When tokens can't leave the building — how local inference plugs into the same pipelines.",
    body: `
Some work simply cannot leak tokens. Client material under NDA, regulated documents, internal data that policy says never crosses the network boundary — for these, "we have a privacy policy" is not an architecture. The only honest answer is inference that physically happens on hardware you control.

Braavolabs treats that answer as a first-class provider, not a special mode.

## Local is just another endpoint

Three of our twelve BYOK providers are local: Ollama, LM Studio, and any custom OpenAI-compatible server. All three speak the same chat-completions wire format the cloud providers use, so to the router your laptop is simply an endpoint with a base URL — Ollama's default is localhost:11434, LM Studio's is localhost:1234 — and no API key leaving the building because there's no key at all.

Our default local model is Gemma 3 4B. It's the pragmatic sweet spot: small enough to run comfortably on a 16GB laptop, capable enough to drive real pipeline steps. If you have more hardware, the larger Gemma variants and the usual local suspects — Llama, Qwen, DeepSeek — are a pull command away, and the platform lists them as selectable models rather than making you type identifiers from memory.

## Same pipelines, same brakes

Here's the part we care most about: switching to local inference changes nothing else. The agent loop is identical. Tool calls are still logged, every step still records its required reasoning, spends still wait for approvals, and all five risk-stops — hard, loop, cost, spam, brand — still run between steps. Governance in Braavolabs lives in the pipeline layer, not in any model vendor's cloud, so it travels with you to the edge. An offline agent is not an ungoverned agent.

This matters because the environments that demand local inference are usually the ones that demand the most accountability, not the least. Air-gapped doesn't mean audit-free.

## Honest expectations

A 4B model is not a frontier model, and pretending otherwise would waste your time. Small local models are weaker at long-horizon, many-step tool use; they lose the thread faster and need more explicit instructions. The pattern that works: keep offline pipelines tighter and more prescriptive, lean harder on approvals and ask_user checkpoints, and route the judgment-heavy steps to a bigger local model if your hardware allows. The router makes the mix a configuration choice — sensitive steps local, everything else wherever you like — so privacy is per-step, not all-or-nothing.

## Air-gapped, with teeth

For environments where even the control plane can't phone home, pipelines export as encrypted, machine-bound bundles. The bundle is encrypted for a specific machine: the license token is derived per device, so a copied bundle on different hardware simply fails to open. There's an explicit machine-change flow when you genuinely migrate — deliberate, bounded, and logged — rather than a quiet copy-anywhere loophole. That's the difference between "offline export" as a checkbox and as a security property.

## The cost column reads zero

One more property falls out for free: local tokens cost nothing. Braavolabs charges a flat plan and never marks up inference, so a pipeline running against your own Ollama box has no per-token line at all — useful for high-volume, low-stakes steps even when privacy isn't the driver.

The deeper point is symmetry. We refuse model lock-in across cloud vendors, and the same principle holds across the cloud boundary itself: where your inference runs should be your decision, revisable any time, with the same pipelines and the same audit trail on either side of it.

Try Braavolabs free — and when the work demands it, run it where nobody else can see it.
`,
  },
  {
    slug: "shipping-ask-user",
    title: "What we learned shipping ask_user",
    category: "Field notes",
    date: "Apr 30, 2026",
    read: "4 min",
    desc: "Agents that ask the right question at the right moment beat agents that guess.",
    body: `
The best agents aren't the ones that never need help. They're the ones that know the moment they need it — and ask a sharp question instead of guessing. That conviction turned into ask_user: a tool any Braavolabs agent can call to stop the run and put a question in front of its operator. Building it taught us more than we expected. Field notes follow.

## Reuse the gate people already trust

Our first design had a brand-new "questions inbox." We deleted it. Braavolabs already has a gate operators check and trust — the approval queue, where every spend waits for an explicit yes. So an agent's question became just another approval, of an input type, flowing through the same queue, the same push notification, the same decision endpoint. One muscle memory instead of two. The lesson generalizes: every new kind of interrupt you invent is a new place for someone to forget to look.

## Pausing is easy; resuming is the feature

The scary part of "the run stops and waits" is what happens after the answer arrives. Our early prototype re-ran the plan from the top — which meant a paused outreach pipeline could re-send emails that had already gone out. Unacceptable, obviously, and also subtly wrong on cost: re-executed steps would re-bill, and the budget math would lie.

So resume became an idempotency contract. Steps that already completed are skipped and their saved outputs restored; cost already incurred is seeded into the resumed accounting so nothing double-counts and the cost-anomaly stop keeps seeing the truth. None of this is glamorous engineering. All of it is why people now pause runs without flinching.

## If asking is expensive, agents will guess

We tuned the prompt guidance so that asking is framed as the cheap, correct move under genuine ambiguity — because the alternative is silent assumptions, and assumptions compound across a multi-step run. One guessed detail at step three becomes a confidently wrong deliverable at step eleven. A thirty-second question is the cheapest correction you will ever buy. The same lesson applies to the human side: the answer form had to be one tap away from the notification, or operators would defer answering and the run would sit parked.

## The question is a UX surface

We cap question length, store the asked question verbatim in the audit trail, and route the notification straight to the run detail where the answer form lives — not to a generic list. Small choices, but they're the difference between "the agent asked something somewhere" and a decision you can make from a phone in the time it takes the kettle to boil.

What we shipped is small on the surface: one tool, one pause, one form. What it changed is the default posture of every pipeline — from "guess and hope" to "ask and proceed." We'll take that trade every time.

Try Braavolabs free and let your first agent ask you something.
`,
  },
  {
    slug: "audit-trail-youd-actually-read",
    title: "Designing an audit trail you'd actually read",
    category: "Governance",
    date: "Apr 23, 2026",
    read: "7 min",
    desc: "Reasoning, tool calls and cost — every step reconstructable, none of it noise.",
    body: `
Most audit logs are written to be ignored. They exist so a compliance box can be ticked, they capture everything indiscriminately, and the one time someone actually opens them — after an incident — they find a haystack engineered without needles in mind. We refused to ship that. If software is going to act autonomously on your behalf, the record of what it did and why isn't a feature; it's the basis of the entire relationship.

So we designed the Braavolabs audit trail backwards: from the questions a human asks, to the data that answers them.

## Four invariants, no exceptions

Everything rests on four rules that hold across the whole platform — they're in our engineering guidelines as non-negotiables, and the code enforces them rather than recommending them.

- Every tool call is logged. Each action an agent takes — every send, every fetch, every write — lands in the tool-call record with its inputs, outputs and timing. Not a sample. All of them.
- Every step has a reasoning field, and it's required. Before the what, the agent records the why. The schema won't accept an empty one — explanation is captured at decision time, not reconstructed after.
- Every spend has an approval row. No money-touching action executes without an explicit decision attached to it. The pause-and-ask machinery for agent questions was built on this same primitive, because a gate people already check is worth ten new ones.
- The activity log covers everything else. Every create, update, send, and decision — human or agent — writes an activity entry, including the governance engine's own interventions.

## Three questions, answered fast

A trail you'd actually read is one that answers, in seconds: what happened, why did it happen, and what did it cost. Our unit of reading is the step: its stated reasoning, the tool calls it made, and the cost it accrued, in one place. A run is a sequence of those units; reconstructing it is scrolling, not archaeology.

The same standard applies when something is stopped. When a risk-stop fires — a loop of failures, a budget overrun, a spam threshold — the log entry carries a human-readable reason: which stop, what it observed, the numbers behind it. "Three unanswered messages to the same recipient" is a sentence an operator acts on. An error code is a support ticket.

## The discipline of less

The counterintuitive part of a readable trail is restraint. Logging everything verbatim buries the signal, so we log decisions and effects, not chatter: one entry per meaningful event, questions and reasons captured at sensible lengths, payloads referenced rather than echoed in full where the full body adds nothing. The test we apply is simple — would the person reading this row at 2am be glad it exists, or scrolling past it?

## Reasoning-required is the hill

Of the four invariants, mandatory reasoning is the one we defend hardest, because it's the one that looks optional. It isn't. Post-hoc explanations are reconstructions — flattering, lossy, often wrong. A reasoning field written at decision time is evidence. It's also, quietly, an alignment tool: an agent forced to state why it's doing something before doing it is an agent whose drift you catch one step early, and whose record you can challenge with specifics instead of vibes.

## Trust is the product

Here's the loop we're really building. You give agents more autonomy when you can steer them and stop them; you steer and stop them well when you can see exactly what they're doing and why; you can see that because every step, call, spend and decision leaves a record designed to be read. The audit trail isn't the boring part of an agent platform. It's the part that makes the exciting parts safe to use.

Try Braavolabs free — and read exactly what your agents did, the same evening.
`,
  },
];

export function getPost(slug: string): BlogPost | undefined {
  return POSTS.find((p) => p.slug === slug);
}

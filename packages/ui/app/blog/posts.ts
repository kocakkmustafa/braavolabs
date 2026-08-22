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
 * current product contracts). No invented customers, metrics or benchmarks.
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

Review the public contract, then continue to the authenticated app when the run model fits your work.
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

Review the governance boundaries in the docs before enabling a run.
`,
  },
  {
    slug: "byok-routing-without-lock-in",
    title: "BYOK: routing models without lock-in",
    category: "Engineering",
    date: "May 21, 2026",
    read: "9 min",
    desc: "The router that lets each step pick the best model — and swap it without touching your pipeline.",
    body: `
The model market reshuffles itself every few months. A provider that leads on reasoning today gets undercut on price tomorrow; a model that didn't exist last quarter becomes the obvious choice for summarization. If your automation platform hard-wires you to one vendor, every one of those shifts is someone else's pricing decision landing on your bill.

We built Braavolabs the other way around: bring your own keys, and let the platform route.

## Provider choice, one wire

The router can use configured cloud providers and local endpoints such as Ollama, LM Studio, or a custom OpenAI-compatible endpoint. Available routes depend on the connections the operator configures; the public contract does not claim a fixed provider count.

That abstraction is the point. Your pipelines are written against the router, not against a vendor SDK. Swapping providers is a settings change, not a migration: no pipeline definitions touched, no prompts rewritten, no redeploy. When the market moves, you move with it in one screen.

## How a run finds its model

When a run starts, the router resolves the model route selected for that work. Braavolabs does not include inference: configure your own provider key or an available local model endpoint. If the selected route has no usable credential or endpoint, the run should fail clearly instead of silently substituting a model you did not choose.

That last behavior is deliberate. Silent model substitution is how platforms quietly trade your output quality for their margin. We'd rather fail with an instruction than succeed with a surprise.

## What happens to your keys

A provider key is among the most sensitive things you can hand a platform, so we treat it accordingly. Keys are encrypted with AES-256-GCM before they're stored — authenticated encryption, per-row derived keys — and the plaintext is never returned by the API afterwards. The dashboard can tell you a key exists; it cannot show it back to you, and neither can anyone who gets a copy of a database dump.

## The local escape hatch

Ollama, LM Studio, and custom OpenAI-compatible endpoints can be selected as local model routes when the operator has installed and configured them. That changes where model inference is sent; it does not by itself prove that tools, telemetry, or the surrounding control plane make no network requests. Those boundaries must be evaluated for the selected data mode and task.

## The economics of not metering you

BYOK makes the billing boundary explicit. Individual is $19/month and Team is $39/active-user/month. Inference is not included, so provider usage is billed through the operator's own account or handled by the operator's local runtime.

Per-task pricing deserves a moment of attention, because it's the dominant model in automation and it quietly punishes exactly the behavior agents are good at. A multi-step agent might take dozens of small steps to do one piece of real work; charge per step or per task, and the bill scales with the agent's thoroughness rather than with the value delivered. The incentive lands on you to keep automations shallow. Flat platform fee plus at-cost tokens points the incentive the right way: deeper pipelines cost us nothing extra, so nothing in our pricing nudges you to cripple them.

## Routing as strategy, not plumbing

The practical pattern is to select routes by task: a reasoning model where judgment matters, a faster route for extraction and glue steps, or a local endpoint where its verified boundary fits the work. The router keeps that choice explicit rather than silently substituting a vendor.

Vendors will keep leapfrogging each other. That's good for you, but only if switching costs stay near zero. Keeping them near zero is the router's whole job.

Review pricing, connect your own model route, and keep the inference bill visible at its source.
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

A phone that can approve spending and redirect agents is a credential. The current client uses SecureStore for auth tokens and the authenticated session contract used by the app. Mobile actions are intended to write into the same activity model; signed, independently verifiable evidence for that record remains in development.

## Why this split works

Mid-run steering changed what a phone could be worth. Before it, a mobile app for an agent platform was a read-only status widget — nice, optional. Once a run can accept guidance in flight and pause on a question, the phone becomes the difference between an agent waiting twelve minutes for you versus twelve hours. The web is where you build the machine. The pocket is where you keep your hand on it.

Review the mobile control contract before pairing a device.
`,
  },
  {
    slug: "local-model-routing-boundaries",
    title: "What local model routing does — and does not — guarantee",
    category: "Engineering",
    date: "May 7, 2026",
    read: "8 min",
    desc: "Local model routing changes the inference endpoint; data mode, tools, and network boundaries still need explicit review.",
    body: `
Local model routing means the selected inference request is sent to an endpoint the operator configured, such as Ollama, LM Studio, or another compatible runtime. Braavolabs does not bundle the runtime, model, hardware, or inference usage.

## The endpoint is only one boundary

Choosing a local endpoint does not make the whole task disconnected from the network. Tool calls, external integrations, updates, telemetry, and the surrounding control plane can have separate network behavior. Review each of those surfaces before treating a task as suitable for restricted data.

## Data mode remains explicit

Private Mode keeps prompt, output, and artifact content end-to-end encrypted so Braavolabs cloud cannot read the plaintext.

Cloud Agent Mode processes the content needed to run the task in Braavolabs execution infrastructure with explicit consent and visible retention.

Those sentences describe the two product data modes. They do not certify the operator's device, local runtime, third-party tools, or network configuration.

## Billing remains separate

Inference is not included. Use your own provider keys (BYOK) or local models. A local runtime can have hardware, electricity, licensing, and operational costs even when there is no provider token invoice.

## Verify the actual task

Before using a local route for sensitive work, inspect the selected runtime, tool list, integrations, update behavior, and network controls. Signed evidence is in development, so public copy must not turn a routing option into a broader security guarantee.
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

Review the run and approval contract before connecting an agent.
`,
  },
  {
    slug: "audit-trail-youd-actually-read",
    title: "Designing an audit trail you'd actually read",
    category: "Governance",
    date: "Apr 23, 2026",
    read: "7 min",
    desc: "How current run records are organized for review, and where signed verification is still in development.",
    body: `
Most audit logs are written to be ignored. They exist so a compliance box can be ticked, they capture everything indiscriminately, and the one time someone actually opens them — after an incident — they find a haystack engineered without needles in mind. We refused to ship that. If software is going to act autonomously on your behalf, the record of what it did and why isn't a feature; it's the basis of the entire relationship.

So we designed the Braavolabs audit trail backwards: from the questions a human asks, to the data that answers them.

## The current record model

The run model has separate records for steps, tool calls, approvals, costs, and activity events. That structure makes it possible to inspect what the current runtime persisted without claiming that all external actions are already covered.

- Tool integrations can attach their inputs, outputs, and timing to tool-call records.
- Run steps carry a reasoning field in the current schema.
- Approval records bind decisions to the action context represented by the runtime.
- Activity entries capture supported lifecycle events and governance interventions.

Coverage must be proven per surface. Signed evidence remains in development, so these database records are not presented as an independently verifiable replay.

## Three questions, answered fast

A trail you'd actually read is one that answers, in seconds: what happened, why did it happen, and what did it cost. Our unit of reading is the step: its stated reasoning, the tool calls it made, and the cost it accrued, in one place. A run is a sequence of those units; reconstructing it is scrolling, not archaeology.

The same standard applies when something is stopped. When a risk-stop fires — a loop of failures, a budget overrun, a spam threshold — the log entry carries a human-readable reason: which stop, what it observed, the numbers behind it. "Three unanswered messages to the same recipient" is a sentence an operator acts on. An error code is a support ticket.

## The discipline of less

The counterintuitive part of a readable trail is restraint. Logging everything verbatim buries the signal, so we log decisions and effects, not chatter: one entry per meaningful event, questions and reasons captured at sensible lengths, payloads referenced rather than echoed in full where the full body adds nothing. The test we apply is simple — would the person reading this row at 2am be glad it exists, or scrolling past it?

## Reasoning-required is the hill

Of the four invariants, mandatory reasoning is the one we defend hardest, because it's the one that looks optional. It isn't. Post-hoc explanations are reconstructions — flattering, lossy, often wrong. A reasoning field written at decision time is evidence. It's also, quietly, an alignment tool: an agent forced to state why it's doing something before doing it is an agent whose drift you catch one step early, and whose record you can challenge with specifics instead of vibes.

## Trust is the product

Here's the loop we're really building. You give agents more autonomy when you can steer them and stop them; you steer and stop them well when you can see exactly what they're doing and why; you can see that because every step, call, spend and decision leaves a record designed to be read. The audit trail isn't the boring part of an agent platform. It's the part that makes the exciting parts safe to use.

Use the run detail to review the records the current runtime produced.
`,
  },
];

export function getPost(slug: string): BlogPost | undefined {
  return POSTS.find((p) => p.slug === slug);
}

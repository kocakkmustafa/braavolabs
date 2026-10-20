import { formatDateTime, formatNumber } from "../../i18n/locales";

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
    "slug": "steer-agents-mid-run",
    "title": "Steering a run without starting over",
    "category": "Product",
    "date": "Jun 2, 2026",
    "read": "3 min",
    "desc": "How operator guidance and saved steps help redirect supported work, and where their guarantees end.",
    "body": "A run can need a correction after it has started: a different customer, a tighter constraint, or a question the original brief did not answer. Braavolabs supports steering guidance and ask_user decisions so the operator can respond in context.\n\n## A request has stages\n\nSubmitting guidance, accepting the request, consuming it at an execution boundary and following it in the output are different events. An active provider call can continue before the next boundary. Read the later run state and result before concluding that an instruction took effect.\n\n## Preserve useful work, inspect uncertain work\n\nResuming can reuse saved completed steps. It does not prove exactly-once delivery for external effects, and it does not guarantee zero additional provider cost. If a connection fails during a send or payment, check the destination before manually retrying.\n\n## Ask rather than infer permission\n\nAn ask_user decision requests information. A separate supported action can request approval. Read the scope of each decision: an answer to a question is not permission for unrelated work. These controls help make a working session inspectable; their presence does not establish that every route or external tool has identical behavior."
  },
  {
    "slug": "five-risk-stops-explained",
    "title": "The five risk stops and their boundaries",
    "category": "Governance",
    "date": "May 28, 2026",
    "read": "3 min",
    "desc": "Hard, loop, cost, spam and brand checks help govern supported execution paths.",
    "body": "Braavolabs names five governance checks: hard, loop, cost, spam and brand. Understanding their purpose also means understanding when they can act.\n\n## Five checks\n\nThe hard stop checks a stop condition. The loop check looks for repeated behavior. The cost check compares recorded usage with configured limits. Spam and brand checks apply policy to supported outreach and content paths. Review the configuration and execution path rather than assuming every tool receives the same checks.\n\n## Boundaries matter\n\nA check can prevent further supported work when the execution reaches it. It cannot recall a request already sent to a provider or reverse an external effect. Usage records can arrive after a charge, so a configured budget is not a guarantee that the provider bill can never exceed it.\n\n## Read the result\n\nWhen a check changes run state, inspect the recorded reason and relevant step. Missing status or cost data is unknown, not evidence that the run is safe or free. Notifications depend on permission and delivery; the current run record is the place to confirm state. Before resuming, review both the local result and any external service involved."
  },
  {
    "slug": "byok-routing-without-lock-in",
    "title": "Choosing cloud and local model routes",
    "category": "Engineering",
    "date": "May 21, 2026",
    "read": "3 min",
    "desc": "Keep provider choice explicit while checking capabilities, costs and credential boundaries.",
    "body": "Braavolabs supports configured cloud credentials and compatible customer-operated endpoints. The useful promise is an explicit route choice, not that every model is interchangeable or that an unmeasured model is always best.\n\n## Check the route you choose\n\nReview the available model, tool support, data mode and endpoint reachability. A provider change can change output quality, latency, price and supported parameters. If a selected route is unavailable, inspect the error rather than assuming a different model silently completed the work.\n\n## Separate subscription and inference\n\nThe proposed Individual and Team subscriptions do not include inference. Provider charges belong to the configured account; local models still require hardware and operation. Compare reported usage with provider billing. Unknown cost is not zero cost.\n\n## Protect the relevant credential store\n\nServer-stored cloud keys use the implemented AES-256-GCM format. Server key protection, runtime access and backups still matter. CLI direct-provider configuration and desktop credential storage have separate boundaries. Review the store that actually makes the request, and revoke access in the provider as well when necessary. A common interface helps organize work; it does not establish identical security or economics across routes."
  },
  {
    "slug": "pocket-steering",
    "title": "Monitor and decide from your phone",
    "category": "Product",
    "date": "May 14, 2026",
    "read": "3 min",
    "desc": "The mobile companion focuses on supported monitoring, approvals, questions and steering.",
    "body": "The mobile companion provides a smaller control surface for work composed on the web. Its core actions are reading run state, handling a pending approval, answering ask_user and sending steering guidance.\n\n## Keep the decision in context\n\nOpen the relevant company and run before acting. Read the exact question or action, and distinguish an information request from permission for an external effect. Provider inference can already incur charges without a separate approval row.\n\n## Treat delivery and state separately\n\nPush notifications depend on device permission, session eligibility, network access and platform delivery. A notification can be delayed; refresh the app to confirm the current decision. A successful steering response records acceptance of the request, not proof that the model followed it.\n\n## Recover carefully\n\nAfter an account switch or interrupted connection, confirm the selected account, company and pending decision again. Inspect current state before resubmitting a timeout. A mobile action cannot retract an external request that already completed. Platform secure storage helps protect device-held session credentials, while physical-device, background-delivery and cross-account tests remain necessary release checks."
  },
  {
    "slug": "local-model-routing-boundaries",
    "title": "Local model routing boundaries",
    "category": "Engineering",
    "date": "May 7, 2026",
    "read": "3 min",
    "desc": "A local inference endpoint is one part of the complete data path.",
    "body": "A compatible customer-operated model server can be configured with an explicit base URL. Braavolabs does not bundle a model or infer a complete privacy policy from the address alone.\n\n## Trace the whole operation\n\nCheck which machine makes the inference call, which model is available and whether the endpoint is reachable from that machine. Then inspect the tools, account services, telemetry, logs and other steps that can still use a network connection. A local URL does not make the complete pipeline offline.\n\n## Review capabilities and cost\n\nModel capabilities and tool support can differ from cloud routes. Review outputs after changing a route. Local inference may remove a provider token charge for that call, but hardware, electricity, maintenance and other connected services still have costs. Missing cost data should remain unknown.\n\n## Keep preview labels precise\n\nPrivate Mode is a preview. Cloud Agent Mode and signed evidence remain in development. Those labels do not establish a complete data-handling contract, an operating-system sandbox or independently verified evidence. Sensitive use requires checking the actual configured data path and execution permissions."
  },
  {
    "slug": "shipping-ask-user",
    "title": "Designing ask_user around a clear question",
    "category": "Field notes",
    "date": "Apr 30, 2026",
    "read": "3 min",
    "desc": "An information request should preserve context and avoid implying unrelated permission.",
    "body": "An agent can encounter missing information while working. ask_user gives that uncertainty a visible decision: a question for the operator, associated with the relevant run.\n\n## Ask one answerable question\n\nA useful question identifies the missing fact and enough context to answer it. It should not disguise an external action as a request for information. Read the question before responding, and keep sensitive credentials out of free-text answers.\n\n## Reuse the decision surface carefully\n\nInformation requests and supported approval actions can appear in the same decision workflow, but they have different meanings. Answering a question is not authorization for unrelated work. Nor does the presence of an approval queue mean every provider inference charge waits for an explicit yes.\n\n## Check what happens next\n\nAfter sending an answer, inspect the decision and run state. A received answer, a resumed run and a completed external effect are separate observations. If the connection times out, check whether the answer was recorded before resubmitting. Saved completed steps can be reused, but external retries still require reconciliation. This is a design rationale for a visible operator decision, not a measured customer study or a claim of exactly-once execution."
  },
  {
    "slug": "audit-trail-youd-actually-read",
    "title": "Reading the recorded activity of a run",
    "category": "Governance",
    "date": "Apr 23, 2026",
    "read": "3 min",
    "desc": "Use recorded status, outputs, decisions and available costs without inventing missing evidence.",
    "body": "An operator needs to understand what a run attempted, which decisions were requested and what result was recorded. Braavolabs activity and step views organize those records around the run.\n\n## Start with the recorded facts\n\nRead the step status, available output, recorded decision summary and any reported cost. Keep unavailable values visibly unknown. A dispatch record or successful API acknowledgement does not prove that an external message, payment or workflow completed.\n\n## Reconcile before retrying\n\nA provider or tool can finish while a client loses its connection. Compare the run record with the destination service before repeating an uncertain external effect. Saved steps and history are useful evidence, but they do not establish complete, immutable or independently verified coverage of every action.\n\n## Protect the record\n\nPrompts, tool outputs and free-text answers can contain sensitive data. Limit access and preserve only the exports needed for your operation. Review retention, backups and restoration rather than assuming a visible activity page is a backup. Signed evidence remains in development; the current record should not be presented as a certification, a complete private reasoning trace or proof of legal compliance."
  }
];

export function getPost(slug: string): BlogPost | undefined {
  return POSTS.find((p) => p.slug === slug);
}

type ContentCopy = { raw(key: string): unknown };
function translatedText(copy: ContentCopy, key: string): string {
  const value = copy.raw(key);
  if (typeof value !== "string") throw new Error(`Invalid content message: ${key}`);
  return value;
}

/** The original date and reading duration keep their meaning in every locale. */
export function localizePost(post: BlogPost, copy: ContentCopy, locale: string): BlogPost {
  const prefix = `blog.${post.slug}`;
  return { ...post, title: translatedText(copy, `${prefix}.title`), desc: translatedText(copy, `${prefix}.desc`), body: translatedText(copy, `${prefix}.body`),
    date: formatDateTime(post.date, locale, { timeZone: "UTC", dateStyle: "medium" }),
    read: formatNumber(Number.parseInt(post.read, 10), locale, { style: "unit", unit: "minute" }),
  };
}

export function blogCategoryLabel(category: BlogCategory | "All", copy: ContentCopy): string {
  const key = { All: "all", Product: "product", Engineering: "engineering", Governance: "governance", "Field notes": "fieldNotes" }[category];
  return translatedText(copy, `blogCategories.${key}`);
}

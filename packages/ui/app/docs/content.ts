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
  {
    "slug": "getting-started",
    "title": "Getting started",
    "nav": "Getting started",
    "category": "Start here",
    "icon": "rocket_launch",
    "order": 1,
    "desc": "Create a workspace, review a pipeline, and follow a governed run with explicit model and data choices.",
    "blocks": [
      {
        "kind": "para",
        "text": "Braavolabs combines a web workspace, desktop and CLI workbenches, and a mobile companion for model and agent work. Choose the model route and data mode deliberately before starting a run."
      },
      {
        "kind": "heading",
        "id": "the-first-run",
        "text": "Your first run"
      },
      {
        "kind": "steps",
        "items": [
          {
            "title": "Sign in and describe the work",
            "body": "Create an account on the authenticated app. In the company builder, describe your goal, audience and constraints. The builder may ask clarifying questions before proposing a plan."
          },
          {
            "title": "Review the proposal",
            "body": "Check the generated agents, pipeline steps, configured tools and expected outputs. Edit or remove anything you do not want. A proposed plan is not evidence that an external integration is connected."
          },
          {
            "title": "Choose a route and start",
            "body": "Configure an available provider key or compatible local endpoint. Review its capabilities and data handling, then start the pipeline. Provider inference can incur charges when work begins."
          },
          {
            "title": "Follow status and decisions",
            "body": "Read the recorded steps, available cost data, pending approvals and ask_user questions. Respond to the specific decision shown. You can send steering guidance or request a stop; an active call or external effect may already be in progress."
          }
        ]
      },
      {
        "kind": "heading",
        "id": "plans-and-inference",
        "text": "Plans and inference"
      },
      {
        "kind": "para",
        "text": "Individual ($19/month) and Team ($39/active user/month) are preview plan descriptions and are not currently available to purchase. Inference is separate: provider charges, local hardware and operation costs are not included."
      },
      {
        "kind": "para",
        "text": "Private Mode is a preview. Cloud Agent Mode and signed evidence remain in development. Holding is a premium/private preview. Do not treat these labels as a complete security or availability guarantee."
      },
      {
        "kind": "para",
        "text": "Use the web for composing companies and pipelines. Use the mobile companion to monitor, answer, approve and steer supported work."
      }
    ]
  },
  {
    "slug": "concepts",
    "title": "Core concepts",
    "nav": "Concepts",
    "category": "Concepts",
    "icon": "schema",
    "order": 2,
    "desc": "Understand companies, agents, pipelines, runs, decisions and recorded activity.",
    "blocks": [
      {
        "kind": "para",
        "text": "A company groups a goal, agents and pipelines inside your authenticated workspace. An agent performs a role; a pipeline orders work; a run is one execution of that pipeline. Multiple companies can belong to the same account or tenant."
      },
      {
        "kind": "heading",
        "id": "primitives",
        "text": "Nine building blocks"
      },
      {
        "kind": "para",
        "text": "The builder composes acquisition, sales, delivery, content, operations, finance, analytics, memory and governance roles. These are starting structures to review, not automatic permission to contact people, spend money or access an account."
      },
      {
        "kind": "heading",
        "id": "decisions",
        "text": "Decisions and governance"
      },
      {
        "kind": "para",
        "text": "Supported actions can produce pending approvals. An ask_user decision requests information rather than permission to spend. Read its question and scope before allowing, rejecting or answering. Provider inference is billed separately and does not necessarily wait for an approval row."
      },
      {
        "kind": "para",
        "text": "Governance checks include hard, loop, cost, spam and brand stops. Their coverage depends on the execution path and configuration. A stop prevents further supported work at a check boundary; it cannot retract an already sent request."
      },
      {
        "kind": "heading",
        "id": "records",
        "text": "Read the recorded state"
      },
      {
        "kind": "para",
        "text": "Activity and step records help explain status, outputs, available cost data and decision summaries. Missing data is unknown, not zero. A recorded request is not proof that its external effect completed. Retain important outputs and reconcile external systems before retrying uncertain work."
      },
      {
        "kind": "note",
        "tone": "warn",
        "text": "A company name or a local model endpoint alone does not establish a separate tenant, an operating-system sandbox or an offline-only data path."
      }
    ]
  },
  {
    "slug": "byok-and-providers",
    "title": "BYOK & providers",
    "nav": "BYOK & providers",
    "category": "Reference",
    "icon": "vpn_key",
    "order": 3,
    "desc": "Configure a supported cloud or local model route and understand its cost and data boundaries.",
    "blocks": [
      {
        "kind": "para",
        "text": "Bring your own key (BYOK) means using your provider credentials for supported cloud inference. A compatible customer-operated endpoint is a separate route. Available providers and models come from the authenticated configuration; this page does not promise a fixed provider count."
      },
      {
        "kind": "heading",
        "id": "configure",
        "text": "Configure and check a route"
      },
      {
        "kind": "list",
        "items": [
          "Use a key scoped to the intended provider account. Review its provider-side spending controls and avoid putting secrets into prompts, shared logs or screenshots.",
          "For a local endpoint, confirm its explicit base URL, supported model and reachability from the machine that will make the request.",
          "Check model capabilities, tool support and the selected data mode. Changing providers can change output, price and behavior; a common API shape does not make models interchangeable."
        ]
      },
      {
        "kind": "heading",
        "id": "key-storage",
        "text": "Key storage depends on the surface"
      },
      {
        "kind": "para",
        "text": "Server-stored cloud credentials use the implemented AES-256-GCM storage format. Protecting them also depends on the server key, runtime access and backups. CLI direct-provider configuration and desktop credential storage have their own boundaries; saving a key on one surface does not prove it is available or protected identically on every device."
      },
      {
        "kind": "para",
        "text": "Inference charges go to the configured provider. Local execution can still incur hardware and operation costs. Review reported usage and provider billing together; unavailable cost data is not zero-cost usage."
      },
      {
        "kind": "note",
        "tone": "warn",
        "text": "A local inference URL does not make tools, telemetry, account services or the complete pipeline offline. Review the complete data path before processing sensitive material."
      }
    ]
  },
  {
    "slug": "mid-run-steering",
    "title": "Mid-run steering & ask_user",
    "nav": "Steering & ask_user",
    "category": "Concepts",
    "icon": "alt_route",
    "order": 4,
    "desc": "Send guidance, answer a question, or request a stop while following the recorded run state.",
    "blocks": [
      {
        "kind": "para",
        "text": "Steering lets you send additional operator guidance to a supported run. State the change clearly: the intended customer, constraint or next step. The request is consumed at an available execution boundary, rather than guaranteeing an immediate interruption of an active provider call."
      },
      {
        "kind": "heading",
        "id": "states",
        "text": "Read the acknowledgement carefully"
      },
      {
        "kind": "para",
        "text": "A successful request means the system accepted that request. It does not by itself prove the model received, applied or followed the instruction. Follow the subsequent run state and output. If a request fails or times out, inspect the current state before resubmitting."
      },
      {
        "kind": "heading",
        "id": "ask-user",
        "text": "Answer an ask_user question"
      },
      {
        "kind": "para",
        "text": "When an agent requests information, open the matching pending decision and read the question and context. Submit the answer once, then check whether the decision and run state changed. Do not confuse an information request with authorization for an unrelated action."
      },
      {
        "kind": "heading",
        "id": "resume",
        "text": "Resume with care"
      },
      {
        "kind": "para",
        "text": "Saved completed steps can be reused when work resumes. This does not establish exactly-once delivery for provider calls, emails, payments or other external effects. A pause, stop or failed connection can occur while an effect is in progress. Check recorded output and the external service before manually retrying uncertain work."
      },
      {
        "kind": "note",
        "tone": "warn",
        "text": "Pause, resume and steering do not guarantee zero additional cost or reverse an external effect that already happened."
      }
    ]
  },
  {
    "slug": "webhooks",
    "title": "Webhooks",
    "nav": "Webhooks",
    "category": "Reference",
    "icon": "webhook",
    "order": 5,
    "desc": "Sign a company webhook with the exact timestamp, raw body and header contract.",
    "blocks": [
      {
        "kind": "para",
        "text": "A configured company webhook accepts POST /hooks/<company-slug>/<event>. Use that company's configured webhook secret and a test company before sending an event that can start work."
      },
      {
        "kind": "heading",
        "id": "signature",
        "text": "Sign the exact bytes"
      },
      {
        "kind": "para",
        "text": "Set X-Webhook-Timestamp to the current Unix time in milliseconds. Compute a hexadecimal HMAC-SHA256 over the timestamp, a literal dot, and the exact raw request body. Send it as X-Webhook-Signature. Do not reserialize or edit the body after signing."
      },
      {
        "kind": "code",
        "lang": "javascript",
        "caption": "Example signed request; replace the API URL, company slug and event.",
        "code": "import { createHmac } from \"node:crypto\";\n\n// Use the configured company webhook secret; keep it out of source control.\nconst secret = process.env.BRAAVO_WEBHOOK_SECRET;\nif (!secret) throw new Error(\"Set BRAAVO_WEBHOOK_SECRET\");\nconst timestamp = String(Date.now()); // milliseconds, not Unix seconds\nconst body = JSON.stringify({ message: \"Example event\" });\nconst signature = createHmac(\"sha256\", secret)\n  .update(timestamp + \".\")\n  .update(body)\n  .digest(\"hex\");\n\n// Sending this request can start configured work. Use a test company.\nconst response = await fetch(\"https://YOUR_API/hooks/COMPANY_SLUG/EVENT\", {\n  method: \"POST\",\n  headers: {\n    \"Content-Type\": \"application/json\",\n    \"X-Webhook-Timestamp\": timestamp,\n    \"X-Webhook-Signature\": signature,\n  },\n  body,\n});\nif (!response.ok) throw new Error(`Webhook rejected: ${response.status}`);"
      },
      {
        "kind": "heading",
        "id": "delivery",
        "text": "Delivery and retries"
      },
      {
        "kind": "para",
        "text": "The server rejects timestamps outside a five-minute window. Signature-based duplicate detection uses Redis with a six-minute entry lifetime; when Redis is unavailable, signature and timestamp checks remain but that duplicate check can be skipped. This is not an exactly-once delivery guarantee."
      },
      {
        "kind": "note",
        "tone": "warn",
        "text": "A successful webhook response is not proof that the pipeline completed. Check run status and use application-level idempotency and reconciliation for external effects. Before retrying a timeout, inspect whether the first request was accepted."
      }
    ]
  },
  {
    "slug": "external-automations",
    "title": "Connecting external automations",
    "nav": "External automations",
    "category": "Reference",
    "icon": "hub",
    "order": 6,
    "desc": "Connect a configured external automation and verify both sides of its execution.",
    "blocks": [
      {
        "kind": "para",
        "text": "Use configured integrations or signed webhooks to connect supported external automation tools. The availability and actions of an integration depend on its actual connection and credentials; naming n8n, Make or Zapier does not mean every workflow is automatically connected."
      },
      {
        "kind": "heading",
        "id": "connect",
        "text": "Make one connection observable"
      },
      {
        "kind": "steps",
        "items": [
          {
            "title": "Choose the boundary",
            "body": "Decide which system starts work, which event it sends and which system owns the result. Connect only the account and permissions needed for that action."
          },
          {
            "title": "Test with harmless data",
            "body": "Use a test company and an external test workflow. Verify the event payload, authentication, resulting run and external result."
          },
          {
            "title": "Plan failure handling",
            "body": "Define timeouts, duplicate handling and a manual reconciliation step. Do not blindly resend a payment, email or other external effect after an uncertain response."
          }
        ]
      },
      {
        "kind": "para",
        "text": "An external workflow status and a Braavolabs run status describe different parts of the operation. Check both. Recorded dispatch or a successful trigger response is not a delivery or completion receipt from the destination."
      },
      {
        "kind": "para",
        "text": "Connection credentials, webhook secrets and provider keys may have different storage and revocation paths. Review the relevant surface and external service when removing access."
      }
    ]
  },
  {
    "slug": "mobile-app",
    "title": "Mobile app",
    "nav": "Mobile app",
    "category": "Reference",
    "icon": "smartphone",
    "order": 7,
    "desc": "Use the mobile companion to monitor, decide and steer supported work.",
    "blocks": [
      {
        "kind": "para",
        "text": "The mobile app is a companion for supported monitoring and control. Compose companies and pipelines on the web, then use the phone to read run status, handle pending decisions and send steering guidance."
      },
      {
        "kind": "heading",
        "id": "four-actions",
        "text": "Monitor, approve, answer and steer"
      },
      {
        "kind": "list",
        "items": [
          "Monitor: open the relevant company and run. Treat unavailable or stale data as unknown; reconnect and refresh before making a decision.",
          "Approve: read the specific pending action and allow or reject it. An approval row does not cover unrelated work or every provider charge.",
          "Answer: respond to an ask_user question in its original context. Check the resulting decision state after submitting.",
          "Steer: send a clear instruction and follow subsequent output. An accepted request is not proof that the instruction was applied."
        ]
      },
      {
        "kind": "heading",
        "id": "access",
        "text": "Sessions and notifications"
      },
      {
        "kind": "para",
        "text": "Notifications depend on device permission, an eligible session, network access and delivery by the platform. Open the app to verify the latest state rather than treating a push notification as a complete execution record. Device-held session credentials use platform secure storage; protection and background behavior still depend on the device and operating system."
      },
      {
        "kind": "para",
        "text": "After switching accounts, confirm the selected company and pending decision again. On a timeout, inspect current state before retrying. The app cannot undo an external effect that already completed."
      },
      {
        "kind": "para",
        "text": "Choose your preferred language and light, dark or system theme in the app. After changing language or account, confirm the current workspace and decision context before acting."
      }
    ]
  },
  {
    "slug": "faq",
    "title": "Frequently asked questions",
    "nav": "FAQ",
    "category": "Start here",
    "icon": "quiz",
    "order": 8,
    "desc": "Answers about previews, costs, local models, approvals and uncertain runs.",
    "blocks": [
      {
        "kind": "faq",
        "items": [
          {
            "q": "Can I buy a plan now?",
            "a": "Individual ($19/month) and Team ($39/active user/month) are preview descriptions and are not currently available to purchase. Inference is separate from the proposed subscription."
          },
          {
            "q": "Does every charge require an approval?",
            "a": "No. Supported actions can require a pending decision, but provider inference can incur charges when a run starts. Read the action and provider spending controls before running work."
          },
          {
            "q": "Does a local model make the platform offline?",
            "a": "No. A compatible local endpoint controls that inference route. Tools, account services, telemetry and other pipeline steps require their own data-path review."
          },
          {
            "q": "Will resume repeat an external action?",
            "a": "Saved completed steps can be reused, but exactly-once external delivery is not established. Check the run and external service before retrying uncertain work."
          },
          {
            "q": "Did an accepted steering request change the model output?",
            "a": "Acceptance records the request. Follow the next execution boundary and output to determine whether the instruction was applied and followed."
          },
          {
            "q": "Can I build a complete company on my phone?",
            "a": "The web is the authoring surface. The mobile companion focuses on monitoring, approvals, answers and steering."
          },
          {
            "q": "Are Private Mode, Cloud Agent Mode and signed evidence generally available?",
            "a": "Private Mode is a preview; Cloud Agent Mode and signed evidence are in development. Their names are not a complete security or availability guarantee."
          },
          {
            "q": "Does deleting an account cancel an external subscription?",
            "a": "Do not assume it does. Check the subscription provider and any external service separately, and preserve required exports before deleting data."
          }
        ]
      }
    ]
  }
];

export function getDoc(slug: string): DocPage | undefined {
  return DOCS.find((d) => d.slug === slug);
}

/** Ordered list used by the index, the side nav, and prev/next links. */
export const DOCS_ORDERED: DocPage[] = [...DOCS].sort((a, b) => a.order - b.order);

export type ContentCopy = { raw(key: string): unknown };
function translatedText(copy: ContentCopy, key: string): string {
  const value = copy.raw(key);
  if (typeof value !== "string") throw new Error(`Invalid content message: ${key}`);
  return value;
}

/** Translate human prose while preserving route anchors, code and block kinds. */
export function localizeDoc(doc: DocPage, copy: ContentCopy): DocPage {
  const prefix = `docs.${doc.slug}`;
  const text = (path: string) => translatedText(copy, `${prefix}.${path}`);
  return { ...doc, title: text("title"), nav: text("nav"), desc: text("desc"),
    blocks: doc.blocks.map((block, index): DocBlock => {
      const base = `blocks.${index}`;
      switch (block.kind) {
        case "heading": case "para": case "note": return { ...block, text: text(`${base}.text`) };
        case "list": return { ...block, items: block.items.map((_, item) => text(`${base}.items.${item}`)) };
        case "steps": return { ...block, items: block.items.map((_, item) => ({ title: text(`${base}.items.${item}.title`), body: text(`${base}.items.${item}.body`) })) };
        case "faq": return { ...block, items: block.items.map((_, item) => ({ q: text(`${base}.items.${item}.q`), a: text(`${base}.items.${item}.a`) })) };
        case "code": return { ...block, ...(block.caption ? { caption: text(`${base}.caption`) } : {}) };
      }
    }),
  };
}

export function docCategoryLabel(category: DocCategory, copy: ContentCopy): string {
  const key = { "Start here": "start", Concepts: "concepts", Reference: "reference" }[category];
  return translatedText(copy, `docCategories.${key}`);
}

/** Extract every FAQ item on a page (for FAQPage JSON-LD). */
export function faqItemsOf(page: DocPage): FaqItem[] {
  return page.blocks.flatMap((b) => (b.kind === "faq" ? b.items : []));
}

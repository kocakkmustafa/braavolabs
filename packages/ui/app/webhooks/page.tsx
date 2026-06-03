"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useAuthGuard } from "../../lib/useAuthGuard";

// Stable category ids — labels resolve at render via useTranslations.
const CATEGORIES = [
  { id: "", labelKey: "catAll", icon: "apps" },
  { id: "ecommerce", labelKey: "catEcommerce", icon: "shopping_cart" },
  { id: "payment", labelKey: "catPayment", icon: "payments" },
  { id: "crm", labelKey: "catCrm", icon: "contacts" },
  { id: "dev", labelKey: "catDev", icon: "code" },
  { id: "social", labelKey: "catSocial", icon: "share" },
  { id: "support", labelKey: "catSupport", icon: "support_agent" },
  { id: "marketing", labelKey: "catMarketing", icon: "campaign" },
  { id: "custom", labelKey: "catCustom", icon: "tune" },
];

// Hardcoded webhook templates for frontend-only rendering
const WEBHOOK_TEMPLATES = [
  // E-commerce
  { id: "shopify_order_created", name: "Shopify — New Order", category: "ecommerce", icon: "🛍️", provider: "Shopify", eventType: "orders/create", description: "Trigger when a new order is placed in your Shopify store", popularity: 95, setupInstructions: "Go to Shopify Admin > Settings > Notifications > Webhooks > Create webhook", samplePayload: { id: 5362491, order_number: "#1042", total_price: "149.99", customer: { email: "john@example.com", first_name: "John" } } },
  { id: "shopify_product_updated", name: "Shopify — Product Updated", category: "ecommerce", icon: "🛍️", provider: "Shopify", eventType: "products/update", description: "Trigger when a product is modified in Shopify", popularity: 72, setupInstructions: "Go to Shopify Admin > Settings > Notifications > Webhooks", samplePayload: { id: 788032119, title: "AI Widget Pro", status: "active", variants: [{ price: "29.99" }] } },
  { id: "shopify_checkout_abandoned", name: "Shopify — Abandoned Checkout", category: "ecommerce", icon: "🛍️", provider: "Shopify", eventType: "checkouts/create", description: "Trigger on abandoned checkouts for recovery campaigns", popularity: 88, setupInstructions: "Go to Shopify Admin > Settings > Notifications > Webhooks", samplePayload: { id: 11332, email: "user@example.com", total_price: "89.00", abandoned_checkout_url: "https://shop.example.com/recover/..." } },
  { id: "shopify_customer_created", name: "Shopify — New Customer", category: "ecommerce", icon: "🛍️", provider: "Shopify", eventType: "customers/create", description: "Trigger when a new customer signs up", popularity: 80, setupInstructions: "Go to Shopify Admin > Settings > Notifications > Webhooks", samplePayload: { id: 6940095, email: "new@customer.com", first_name: "Jane", orders_count: 0 } },

  // Payment
  { id: "stripe_payment_succeeded", name: "Stripe — Payment Succeeded", category: "payment", icon: "💳", provider: "Stripe", eventType: "payment_intent.succeeded", description: "Trigger on successful payment", popularity: 96, setupInstructions: "Go to Stripe Dashboard > Developers > Webhooks > Add endpoint", samplePayload: { id: "pi_3QFxyz", amount: 14999, currency: "usd", customer: "cus_ABC123", status: "succeeded" } },
  { id: "stripe_subscription_created", name: "Stripe — New Subscription", category: "payment", icon: "💳", provider: "Stripe", eventType: "customer.subscription.created", description: "Trigger when a customer starts a new subscription", popularity: 90, setupInstructions: "Stripe Dashboard > Developers > Webhooks", samplePayload: { id: "sub_1Kxyz", customer: "cus_ABC123", status: "active", plan: { nickname: "Pro Monthly" } } },
  { id: "stripe_invoice_paid", name: "Stripe — Invoice Paid", category: "payment", icon: "💳", provider: "Stripe", eventType: "invoice.paid", description: "Trigger when an invoice is paid", popularity: 82, setupInstructions: "Stripe Dashboard > Developers > Webhooks", samplePayload: { id: "in_1Mxyz", customer_email: "user@example.com", amount_paid: 4900, status: "paid" } },
  { id: "stripe_refund_issued", name: "Stripe — Refund Issued", category: "payment", icon: "💳", provider: "Stripe", eventType: "charge.refunded", description: "Trigger when a refund is processed", popularity: 68, setupInstructions: "Stripe Dashboard > Developers > Webhooks", samplePayload: { id: "ch_3Pxyz", amount_refunded: 4900, reason: "requested_by_customer" } },

  // Dev Tools
  { id: "github_push", name: "GitHub — Push", category: "dev", icon: "🐙", provider: "GitHub", eventType: "push", description: "Trigger on code push to a repository", popularity: 92, setupInstructions: "Go to repo > Settings > Webhooks > Add webhook", samplePayload: { ref: "refs/heads/main", commits: [{ message: "fix: resolve auth bug", author: { name: "developer" } }], repository: { full_name: "org/repo" } } },
  { id: "github_pr", name: "GitHub — Pull Request", category: "dev", icon: "🐙", provider: "GitHub", eventType: "pull_request", description: "Trigger on PR opened, merged, or closed", popularity: 88, setupInstructions: "Go to repo > Settings > Webhooks", samplePayload: { action: "opened", number: 42, pull_request: { title: "Add new feature", user: { login: "dev" }, merged: false } } },
  { id: "github_issue", name: "GitHub — Issue Created", category: "dev", icon: "🐙", provider: "GitHub", eventType: "issues", description: "Trigger when a new issue is opened", popularity: 75, setupInstructions: "Go to repo > Settings > Webhooks", samplePayload: { action: "opened", issue: { number: 123, title: "Bug report", body: "Steps to reproduce...", labels: [{ name: "bug" }] } } },
  { id: "github_release", name: "GitHub — Release Published", category: "dev", icon: "🐙", provider: "GitHub", eventType: "release", description: "Trigger when a new release is published", popularity: 70, setupInstructions: "Go to repo > Settings > Webhooks", samplePayload: { action: "published", release: { tag_name: "v2.1.0", name: "Version 2.1", body: "What's new..." } } },

  // CRM
  { id: "hubspot_contact_created", name: "HubSpot — Contact Created", category: "crm", icon: "🟠", provider: "HubSpot", eventType: "contact.creation", description: "Trigger when a new contact is added to HubSpot", popularity: 85, setupInstructions: "Go to HubSpot > Settings > Integrations > Private Apps > Webhooks", samplePayload: { objectId: 12345, propertyName: "email", propertyValue: "new@lead.com" } },
  { id: "hubspot_deal_stage", name: "HubSpot — Deal Stage Changed", category: "crm", icon: "🟠", provider: "HubSpot", eventType: "deal.propertyChange", description: "Trigger when a deal moves to a new stage", popularity: 82, setupInstructions: "HubSpot > Settings > Integrations > Webhooks", samplePayload: { objectId: 67890, propertyName: "dealstage", propertyValue: "closedwon" } },
  { id: "hubspot_form_submitted", name: "HubSpot — Form Submitted", category: "crm", icon: "🟠", provider: "HubSpot", eventType: "submission.created", description: "Trigger when a HubSpot form is submitted", popularity: 78, setupInstructions: "HubSpot > Settings > Integrations > Webhooks", samplePayload: { formId: "abc-123", submittedAt: "2026-03-15", values: { email: "lead@company.com", company: "Acme Inc" } } },

  // Social
  { id: "tiktok_new_follower", name: "TikTok — New Follower", category: "social", icon: "🎵", provider: "TikTok", eventType: "user.follow", description: "Trigger when someone follows your TikTok account", popularity: 65, setupInstructions: "Configure via TikTok Developer Portal > Webhooks", samplePayload: { follower_id: "user_789", username: "new_follower", timestamp: "2026-03-15T10:00:00Z" } },
  { id: "tiktok_video_published", name: "TikTok — Video Published", category: "social", icon: "🎵", provider: "TikTok", eventType: "video.publish", description: "Trigger when a new video is published", popularity: 70, setupInstructions: "TikTok Developer Portal > Webhooks", samplePayload: { video_id: "vid_456", title: "New content", view_count: 0, create_time: "2026-03-15" } },
  { id: "linkedin_post_engagement", name: "LinkedIn — Post Engagement", category: "social", icon: "💼", provider: "LinkedIn", eventType: "post.engagement", description: "Trigger on likes, comments, or shares on LinkedIn", popularity: 72, setupInstructions: "Configure via LinkedIn Marketing API webhooks", samplePayload: { post_id: "urn:li:share:123", engagement_type: "LIKE", actor: "John Smith", timestamp: "2026-03-15" } },

  // Support
  { id: "intercom_conversation_started", name: "Intercom — New Conversation", category: "support", icon: "🔵", provider: "Intercom", eventType: "conversation.user.created", description: "Trigger when a customer starts a new conversation", popularity: 80, setupInstructions: "Intercom > Settings > Webhooks", samplePayload: { type: "conversation", id: "conv_123", user: { email: "customer@example.com" }, body: "I need help with..." } },
  { id: "intercom_user_created", name: "Intercom — New User", category: "support", icon: "🔵", provider: "Intercom", eventType: "user.created", description: "Trigger when a new user is identified", popularity: 68, setupInstructions: "Intercom > Settings > Webhooks", samplePayload: { type: "user", id: "user_456", email: "new@user.com", name: "New User" } },

  // Marketing
  { id: "sendgrid_email_delivered", name: "SendGrid — Email Delivered", category: "marketing", icon: "📧", provider: "SendGrid", eventType: "delivered", description: "Trigger when an email is successfully delivered", popularity: 75, setupInstructions: "SendGrid > Settings > Mail Settings > Event Webhook", samplePayload: { email: "recipient@example.com", event: "delivered", sg_message_id: "msg_xyz", timestamp: 1710500000 } },
  { id: "sendgrid_email_opened", name: "SendGrid — Email Opened", category: "marketing", icon: "📧", provider: "SendGrid", eventType: "open", description: "Trigger when a recipient opens your email", popularity: 78, setupInstructions: "SendGrid > Settings > Mail Settings > Event Webhook", samplePayload: { email: "recipient@example.com", event: "open", ip: "1.2.3.4", useragent: "Chrome" } },
  { id: "sendgrid_email_bounced", name: "SendGrid — Email Bounced", category: "marketing", icon: "📧", provider: "SendGrid", eventType: "bounce", description: "Trigger when an email bounces", popularity: 72, setupInstructions: "SendGrid > Settings > Event Webhook", samplePayload: { email: "bad@address.com", event: "bounce", reason: "550 No such user", type: "bounce" } },

  // Scheduling
  { id: "calendly_booking_created", name: "Calendly — Booking Created", category: "custom", icon: "📅", provider: "Calendly", eventType: "invitee.created", description: "Trigger when someone books a meeting", popularity: 85, setupInstructions: "Calendly > Integrations > Webhooks > Subscribe", samplePayload: { event: "invitee.created", payload: { name: "John Doe", email: "john@example.com", event_type: "30-min Meeting" } } },
  { id: "calendly_booking_cancelled", name: "Calendly — Booking Cancelled", category: "custom", icon: "📅", provider: "Calendly", eventType: "invitee.canceled", description: "Trigger when a booking is cancelled", popularity: 60, setupInstructions: "Calendly > Integrations > Webhooks", samplePayload: { event: "invitee.canceled", payload: { name: "John Doe", email: "john@example.com", cancellation_reason: "Schedule conflict" } } },

  // Forms
  { id: "typeform_form_submitted", name: "Typeform — Form Submitted", category: "custom", icon: "📝", provider: "Typeform", eventType: "form_response", description: "Trigger when a Typeform response is submitted", popularity: 75, setupInstructions: "Typeform > Connect > Webhooks > Add webhook", samplePayload: { event_id: "abc123", form_response: { answers: [{ text: "John Doe" }, { email: "john@example.com" }] } } },

  // Messaging
  { id: "slack_message_posted", name: "Slack — Message Posted", category: "custom", icon: "💬", provider: "Slack", eventType: "message", description: "Trigger when a message is posted in a channel", popularity: 82, setupInstructions: "Slack App > Event Subscriptions > Subscribe to message.channels", samplePayload: { type: "message", channel: "C1234", user: "U5678", text: "Hello team!", ts: "1710500000.000100" } },
  { id: "slack_reaction_added", name: "Slack — Reaction Added", category: "custom", icon: "💬", provider: "Slack", eventType: "reaction_added", description: "Trigger when someone reacts to a message", popularity: 55, setupInstructions: "Slack App > Event Subscriptions", samplePayload: { type: "reaction_added", user: "U5678", reaction: "thumbsup", item: { channel: "C1234", ts: "1710500000" } } },

  // Generic
  { id: "generic_json", name: "Generic JSON Webhook", category: "custom", icon: "🔗", provider: "Any", eventType: "custom", description: "Accept any JSON payload from any service", popularity: 90, setupInstructions: "Point your service webhook URL to the generated endpoint", samplePayload: { event: "custom_event", data: { key: "value" }, timestamp: "2026-03-15T10:00:00Z" } },
  { id: "generic_form_post", name: "Form POST Webhook", category: "custom", icon: "📋", provider: "Any", eventType: "form_post", description: "Accept form-encoded POST data", popularity: 65, setupInstructions: "Set your form action URL to the generated endpoint", samplePayload: { name: "John Doe", email: "john@example.com", message: "Hello!" } },
];

// Sample hooks for the "live endpoints" section (mirrors mock data)
const SAMPLE_HOOKS = [
  { slug: "acme-leads", ev: "lead.created", st: "ok", last: "12s ago", secret: "whsec_8Kd2…a91f", deliveries: 2104, failed: 0 },
  { slug: "acme-leads", ev: "form.submitted", st: "ok", last: "3m ago", secret: "whsec_8Kd2…a91f", deliveries: 831, failed: 2 },
  { slug: "support", ev: "ticket.opened", st: "idle", last: "2d ago", secret: "whsec_p0Lm…77c3", deliveries: 47, failed: 0 },
];

function HookCard({ hook }: { hook: typeof SAMPLE_HOOKS[number] }) {
  const [copied, setCopied] = useState(false);
  const [secretVisible, setSecretVisible] = useState(false);
  const [pingState, setPingState] = useState<"idle" | "pinging" | "done">("idle");

  const url = `https://braavolabs.com/hooks/${hook.slug}/${hook.ev}`;
  const isDelivering = hook.st === "ok";

  function handleCopy() {
    navigator.clipboard.writeText(url).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  function handlePing() {
    setPingState("pinging");
    setTimeout(() => {
      setPingState("done");
      setTimeout(() => setPingState("idle"), 1600);
    }, 900);
  }

  return (
    <div className="bv-glass rounded-2xl px-5 py-4">
      {/* Top row — event type + delivery status */}
      <div className="flex items-center gap-3 flex-wrap">
        <span
          className="bv-mono text-[10px] tracking-widest uppercase px-2 py-0.5 rounded-md"
          style={{
            color: "var(--color-primary)",
            border: "1px solid rgba(59,130,246,0.35)",
            background: "rgba(59,130,246,0.06)",
          }}
        >
          {hook.ev}
        </span>
        <span className="ml-auto flex items-center gap-1.5 bv-mono text-[11.5px] text-on-surface-variant">
          <span
            className={`bv-dot ${isDelivering ? "bv-completed bv-ping" : "bv-paused"}`}
          />
          {isDelivering ? "delivering" : "idle"} · last {hook.last}
        </span>
      </div>

      {/* URL row */}
      <div
        className="flex items-center gap-2.5 mt-3.5 rounded-xl px-3.5 py-2.5"
        style={{
          background: "var(--color-surface-container-low)",
          border: "1px solid var(--color-outline-variant)",
        }}
      >
        <code
          className="bv-mono text-[13px] text-on-surface flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
        >
          https://braavolabs.com/hooks/
          <span style={{ color: "var(--color-secondary)" }}>{hook.slug}</span>
          /{hook.ev}
        </code>
        <button
          onClick={handleCopy}
          className="bv-btn bv-btn-ghost bv-btn-sm flex-none"
          style={copied ? { color: "var(--color-primary)", borderColor: "rgba(59,130,246,0.45)" } : {}}
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>

      {/* HMAC secret row */}
      <div className="flex items-center gap-2.5 mt-2.5 bv-mono text-[12.5px] text-on-surface-variant">
        <span>HMAC secret:</span>
        <span className="text-on-surface tracking-widest">
          {secretVisible ? hook.secret : "••••••••••••••"}
        </span>
        <button
          onClick={() => setSecretVisible((v) => !v)}
          className="bv-btn bv-btn-ghost bv-btn-sm"
        >
          {secretVisible ? "Hide" : "Reveal"}
        </button>
      </div>

      {/* Footer row — delivery count + ping */}
      <div className="flex items-center gap-4 mt-4">
        <span
          className="bv-mono text-[11.5px]"
          style={{ color: "var(--color-outline)" }}
        >
          {hook.deliveries.toLocaleString()} deliveries · {hook.failed} failed
        </span>
        <div className="ml-auto">
          <button
            onClick={handlePing}
            disabled={pingState === "pinging"}
            className="bv-btn bv-btn-ghost bv-btn-sm"
            style={
              pingState === "done"
                ? { color: "var(--color-primary)", borderColor: "rgba(59,130,246,0.45)" }
                : {}
            }
          >
            {pingState === "pinging"
              ? "Pinging…"
              : pingState === "done"
              ? "200 OK ✓"
              : "Send test ping"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function WebhooksPage() {
  const t = useTranslations();
  const { token, hydrated } = useAuthGuard();
  const [selectedCategory, setSelectedCategory] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());

  const filtered = WEBHOOK_TEMPLATES.filter((tmpl) => {
    const matchSearch =
      !search ||
      tmpl.name.toLowerCase().includes(search.toLowerCase()) ||
      tmpl.description.toLowerCase().includes(search.toLowerCase()) ||
      tmpl.provider.toLowerCase().includes(search.toLowerCase());
    const matchCategory = !selectedCategory || tmpl.category === selectedCategory;
    return matchSearch && matchCategory;
  }).sort((a, b) => b.popularity - a.popularity);

  if (!hydrated || !token)
    return (
      <div
        className="flex items-center justify-center min-h-screen"
        style={{ background: "#0a0d14" }}
      >
        <div className="loading-dots">
          <span />
          <span />
          <span />
        </div>
      </div>
    );

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">

      {/* ── Page head ── */}
      <div className="bv-page-head mb-7">
        <div>
          <p className="bv-micro mb-1" style={{ color: "var(--color-outline)" }}>
            Integrations
          </p>
          <h1 className="bv-headline gradient-text">Webhooks</h1>
          <p className="bv-caption mt-1" style={{ color: "var(--color-on-surface-variant)" }}>
            {t("app.webhooks.subtitleTemplate", { count: WEBHOOK_TEMPLATES.length })}
          </p>
        </div>
        <div className="bv-page-head-actions">
          <button className="bv-btn bv-btn-primary bv-sheen">
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
            New endpoint
          </button>
        </div>
      </div>

      {/* ── Live endpoints section ── */}
      <section className="mb-8">
        <h2
          className="bv-title mb-4 flex items-center gap-2"
          style={{ fontFamily: "var(--bv-font-display)", textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 12 }}
        >
          <span className="bv-dot bv-completed bv-ping" />
          Live Endpoints
        </h2>
        <div className="flex flex-col gap-3.5 mb-6">
          {SAMPLE_HOOKS.map((hook, i) => (
            <HookCard key={`${hook.slug}-${hook.ev}-${i}`} hook={hook} />
          ))}
        </div>
      </section>

      {/* ── Sample signed request snippet ── */}
      <section className="mb-8">
        <h2
          className="bv-title mb-4"
          style={{ fontFamily: "var(--bv-font-display)", textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 12, color: "var(--color-on-surface-variant)" }}
        >
          Sample signed request
        </h2>
        <div
          className="rounded-2xl overflow-hidden"
          style={{
            background: "var(--color-surface-container-low)",
            border: "1px solid var(--color-outline-variant)",
          }}
        >
          {/* Snippet header */}
          <div
            className="flex items-center gap-2.5 px-5 py-3.5 bv-mono text-[12px]"
            style={{
              borderBottom: "1px solid var(--color-outline-variant)",
              color: "var(--color-on-surface-variant)",
            }}
          >
            <span className="bv-dot bv-completed" />
            POST · HMAC-SHA256 signature
          </div>
          {/* Code body */}
          <pre
            className="m-0 px-5 py-5 bv-mono text-[12.5px] overflow-x-auto"
            style={{ lineHeight: 1.7, color: "var(--color-on-surface-variant)" }}
          >
            <span style={{ color: "var(--color-outline)" }}>{`# every delivery is signed with your endpoint secret\n`}</span>
            <span style={{ color: "var(--color-primary)" }}>curl</span>
            {` -X POST https://braavolabs.com/hooks/`}
            <span style={{ color: "var(--color-secondary)" }}>acme-leads</span>
            {`/lead.created \\\n  -H `}
            <span style={{ color: "var(--color-primary-fixed)" }}>{`"Content-Type: application/json"`}</span>
            {` \\\n  -H `}
            <span style={{ color: "var(--color-primary-fixed)" }}>{`"X-Braavo-Signature: sha256=9f86d0818…"`}</span>
            {` \\\n  -d `}
            <span style={{ color: "var(--color-primary-fixed)" }}>{`'{"email":"lead@acme.com","source":"site"}'`}</span>
            {`\n\n`}
            <span style={{ color: "var(--color-outline)" }}>{`# verify in your handler:\n`}</span>
            <span style={{ color: "var(--color-primary)" }}>const</span>
            {` sig = hmac(`}
            <span style={{ color: "var(--color-primary-fixed)" }}>"sha256"</span>
            {`, ENDPOINT_SECRET, rawBody);\n`}
            <span style={{ color: "var(--color-primary)" }}>if</span>
            {` (sig !== header(`}
            <span style={{ color: "var(--color-primary-fixed)" }}>"X-Braavo-Signature"</span>
            {`)) reject(`}
            <span style={{ color: "var(--color-primary-fixed)" }}>401</span>
            {`);`}
          </pre>
        </div>
      </section>

      {/* ── Divider ── */}
      <div className="bv-divider mb-7" />

      {/* ── Template library ── */}
      <div className="bv-page-head mb-5">
        <div>
          <h2
            className="bv-title"
            style={{ fontFamily: "var(--bv-font-display)", textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 12, color: "var(--color-on-surface-variant)" }}
          >
            {t("app.webhooks.title")}
          </h2>
          <p className="bv-caption mt-1" style={{ color: "var(--color-outline)" }}>
            {t("app.webhooks.footer")}
          </p>
        </div>
      </div>

      {/* Search */}
      <div className="relative mb-5">
        <span
          className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2"
          style={{ fontSize: 18, color: "var(--color-outline)" }}
        >
          search
        </span>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("app.webhooks.searchPlaceholder")}
          className="w-full pl-10 pr-4 py-2.5 rounded-xl text-sm outline-none"
          style={{
            background: "var(--color-surface-container-low)",
            border: "1px solid var(--color-outline-variant)",
            color: "var(--color-on-surface)",
          }}
        />
      </div>

      {/* Category filter pills */}
      <div className="bv-fpills mb-6">
        {CATEGORIES.map((cat) => {
          const count = cat.id
            ? WEBHOOK_TEMPLATES.filter((tmpl) => tmpl.category === cat.id).length
            : WEBHOOK_TEMPLATES.length;
          return (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id)}
              className={`bv-fpill${selectedCategory === cat.id ? " active" : ""}`}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 13 }}>
                {cat.icon}
              </span>
              {t(`app.webhooks.${cat.labelKey}`)}
              <span className="bv-fpill-count">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Templates list */}
      <div className="flex flex-col gap-2">
        {filtered.map((template) => {
          const isExpanded = expandedId === template.id;
          return (
            <div
              key={template.id}
              className="bv-glass rounded-2xl overflow-hidden"
              style={
                isExpanded
                  ? { borderColor: "rgba(59,130,246,0.25)" }
                  : {}
              }
            >
              {/* Collapsed row */}
              <div
                className="p-4 cursor-pointer flex items-center gap-4"
                onClick={() => setExpandedId(isExpanded ? null : template.id)}
              >
                <span className="text-xl flex-shrink-0">{template.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p
                      className="text-sm font-semibold truncate"
                      style={{ color: "var(--color-on-surface)" }}
                    >
                      {template.name}
                    </p>
                    <span className="bv-pill bv-pill-muted">{template.eventType}</span>
                  </div>
                  <p
                    className="text-xs truncate mt-0.5"
                    style={{ color: "var(--color-on-surface-variant)" }}
                  >
                    {template.description}
                  </p>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <div className="flex items-center gap-1">
                    <span
                      className="material-symbols-outlined"
                      style={{ fontSize: 12, color: "#FF7A1A" }}
                    >
                      star
                    </span>
                    <span
                      className="bv-mono text-[10px]"
                      style={{ color: "var(--color-outline)" }}
                    >
                      {template.popularity}%
                    </span>
                  </div>
                  <span
                    className="material-symbols-outlined"
                    style={{
                      color: "var(--color-outline)",
                      transform: isExpanded ? "rotate(180deg)" : "none",
                      transition: "transform 0.2s",
                      fontSize: 18,
                    }}
                  >
                    expand_more
                  </span>
                </div>
              </div>

              {/* Expanded panel */}
              {isExpanded && (
                <div
                  className="px-4 pb-5"
                  style={{ borderTop: "1px solid var(--color-outline-variant)" }}
                >
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                    {/* Setup Instructions */}
                    <div>
                      <p
                        className="bv-micro mb-2"
                        style={{ color: "var(--color-outline)" }}
                      >
                        {t("app.webhooks.setup")}
                      </p>
                      <p
                        className="bv-body"
                        style={{ color: "var(--color-on-surface-variant)", lineHeight: 1.6 }}
                      >
                        {template.setupInstructions}
                      </p>
                      <div className="mt-3 flex items-center gap-2">
                        <span
                          className="bv-micro"
                          style={{ color: "var(--color-outline)" }}
                        >
                          {t("app.webhooks.providerLabel")}
                        </span>
                        <span
                          className="text-xs font-medium"
                          style={{ color: "var(--color-on-surface-variant)" }}
                        >
                          {template.provider}
                        </span>
                      </div>
                    </div>

                    {/* Sample Payload */}
                    <div>
                      <p
                        className="bv-micro mb-2"
                        style={{ color: "var(--color-outline)" }}
                      >
                        {t("app.webhooks.samplePayload")}
                      </p>
                      <pre
                        className="bv-mono text-[10px] p-3 rounded-xl overflow-x-auto"
                        style={{
                          background: "var(--color-surface-container)",
                          color: "var(--color-on-surface-variant)",
                          lineHeight: 1.6,
                          maxHeight: 160,
                          border: "1px solid var(--color-outline-variant)",
                        }}
                      >
                        {JSON.stringify(template.samplePayload, null, 2)}
                      </pre>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <button
                      onClick={() =>
                        setInstalledIds((prev) => new Set(prev).add(template.id))
                      }
                      disabled={installedIds.has(template.id)}
                      className={`bv-btn ${installedIds.has(template.id) ? "bv-btn-ghost" : "bv-btn-primary bv-sheen"}`}
                      style={
                        installedIds.has(template.id)
                          ? { color: "var(--color-primary)", borderColor: "rgba(59,130,246,0.45)", cursor: "default" }
                          : {}
                      }
                    >
                      {installedIds.has(template.id) ? (
                        <>
                          <span className="material-symbols-outlined" style={{ fontSize: 15 }}>check_circle</span>
                          {t("app.webhooks.installed")}
                        </>
                      ) : (
                        <>
                          <span className="material-symbols-outlined" style={{ fontSize: 15 }}>webhook</span>
                          {t("app.webhooks.install")}
                        </>
                      )}
                    </button>

                    {installedIds.has(template.id) && (
                      <p
                        className="bv-mono text-[10px] leading-relaxed"
                        style={{ color: "var(--color-outline)" }}
                      >
                        {t("app.webhooks.webhookUrlPrefix")}{" "}
                        <code style={{ color: "var(--color-on-surface-variant)" }}>
                          https://yourdomain.com/hooks/{"<your-company>"}/${template.eventType}
                        </code>
                        <br />
                        {t("app.webhooks.footer")}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="text-center py-16">
          <span
            className="material-symbols-outlined block mb-3"
            style={{ fontSize: 40, color: "var(--color-outline)" }}
          >
            webhook
          </span>
          <p className="bv-body" style={{ color: "var(--color-on-surface-variant)" }}>
            {t("app.webhooks.noResults")}
          </p>
        </div>
      )}
    </div>
  );
}

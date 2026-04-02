"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "../../lib/api";
import { useAppStore } from "../../lib/store";

const CATEGORIES = [
  { id: "", label: "All", icon: "apps" },
  { id: "ecommerce", label: "E-Commerce", icon: "shopping_cart" },
  { id: "payment", label: "Payment", icon: "payments" },
  { id: "crm", label: "CRM", icon: "contacts" },
  { id: "dev", label: "Dev Tools", icon: "code" },
  { id: "social", label: "Social", icon: "share" },
  { id: "support", label: "Support", icon: "support_agent" },
  { id: "marketing", label: "Marketing", icon: "campaign" },
  { id: "custom", label: "Custom", icon: "tune" },
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

export default function WebhooksPage() {
  const token = useAppStore((s) => s.token);
  const [selectedCategory, setSelectedCategory] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const filtered = WEBHOOK_TEMPLATES.filter((t) => {
    const matchSearch = !search || t.name.toLowerCase().includes(search.toLowerCase()) || t.description.toLowerCase().includes(search.toLowerCase()) || t.provider.toLowerCase().includes(search.toLowerCase());
    const matchCategory = !selectedCategory || t.category === selectedCategory;
    return matchSearch && matchCategory;
  }).sort((a, b) => b.popularity - a.popularity);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold font-headline gradient-text">Webhook Templates</h1>
          <p className="text-sm mt-0.5" style={{ color: "#859399" }}>
            {WEBHOOK_TEMPLATES.length} pre-built triggers to connect external events to your pipelines
          </p>
        </div>
      </div>

      {/* Search */}
      <div className="relative mb-5">
        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2" style={{ fontSize: 18, color: "#3c494e" }}>search</span>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search webhook templates..." className="w-full pl-10 pr-4 py-2.5 rounded-xl text-sm outline-none" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#e1e2eb" }} />
      </div>

      {/* Category pills */}
      <div className="flex flex-wrap gap-1.5 mb-6">
        {CATEGORIES.map((cat) => {
          const count = cat.id ? WEBHOOK_TEMPLATES.filter((t) => t.category === cat.id).length : WEBHOOK_TEMPLATES.length;
          return (
            <button key={cat.id} onClick={() => setSelectedCategory(cat.id)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all" style={{ background: selectedCategory === cat.id ? "rgba(0,209,255,0.12)" : "rgba(255,255,255,0.04)", color: selectedCategory === cat.id ? "#00d1ff" : "#859399", border: selectedCategory === cat.id ? "1px solid rgba(0,209,255,0.2)" : "1px solid rgba(255,255,255,0.06)" }}>
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{cat.icon}</span>
              {cat.label} ({count})
            </button>
          );
        })}
      </div>

      {/* Templates grid */}
      <div className="space-y-2">
        {filtered.map((template) => {
          const isExpanded = expandedId === template.id;
          return (
            <div key={template.id} className="glass-card rounded-2xl overflow-hidden" style={{ border: isExpanded ? "1px solid rgba(0,209,255,0.12)" : undefined }}>
              <div className="p-4 cursor-pointer flex items-center gap-4" onClick={() => setExpandedId(isExpanded ? null : template.id)}>
                <span className="text-xl flex-shrink-0">{template.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold truncate" style={{ color: "#e1e2eb" }}>{template.name}</p>
                    <span className="text-[10px] px-2 py-0.5 rounded-full flex-shrink-0" style={{ background: "rgba(255,255,255,0.04)", color: "#3c494e" }}>{template.eventType}</span>
                  </div>
                  <p className="text-xs truncate" style={{ color: "#859399" }}>{template.description}</p>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <div className="flex items-center gap-1">
                    <span className="material-symbols-outlined" style={{ fontSize: 12, color: "#fbbf24" }}>star</span>
                    <span className="text-[10px]" style={{ color: "#3c494e" }}>{template.popularity}%</span>
                  </div>
                  <span className="material-symbols-outlined text-sm" style={{ color: "#3c494e", transform: isExpanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>expand_more</span>
                </div>
              </div>

              {isExpanded && (
                <div className="px-4 pb-4" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
                    {/* Setup Instructions */}
                    <div>
                      <p className="text-[10px] font-semibold tracking-wider mb-2" style={{ color: "#3c494e" }}>SETUP</p>
                      <p className="text-xs" style={{ color: "#859399", lineHeight: 1.6 }}>{template.setupInstructions}</p>
                      <div className="mt-3 flex items-center gap-2">
                        <span className="text-[10px]" style={{ color: "#3c494e" }}>Provider:</span>
                        <span className="text-xs font-medium" style={{ color: "#bbc9cf" }}>{template.provider}</span>
                      </div>
                    </div>

                    {/* Sample Payload */}
                    <div>
                      <p className="text-[10px] font-semibold tracking-wider mb-2" style={{ color: "#3c494e" }}>SAMPLE PAYLOAD</p>
                      <pre className="text-[10px] p-3 rounded-xl overflow-x-auto" style={{ background: "rgba(0,0,0,0.3)", color: "#859399", lineHeight: 1.6, maxHeight: 160 }}>
                        {JSON.stringify(template.samplePayload, null, 2)}
                      </pre>
                    </div>
                  </div>

                  <button className="mt-4 w-full sm:w-auto px-6 py-2 rounded-xl text-xs font-semibold text-white transition-all hover:brightness-110" style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}>
                    Install Template
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-16">
          <span className="material-symbols-outlined text-4xl mb-3 block" style={{ color: "#3c494e" }}>webhook</span>
          <p className="text-sm" style={{ color: "#859399" }}>No webhook templates match your search.</p>
        </div>
      )}
    </div>
  );
}

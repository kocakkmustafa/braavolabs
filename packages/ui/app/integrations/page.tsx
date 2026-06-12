"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useAuthGuard } from "../../lib/useAuthGuard";

// Stable category ids — labels resolve via useTranslations at render.
const CATEGORIES = [
  { id: "", labelKey: "catAll", icon: "apps" },
  { id: "crm", labelKey: "catCrm", icon: "contacts" },
  { id: "social_media", labelKey: "catSocial", icon: "share" },
  { id: "email_marketing", labelKey: "catEmail", icon: "mail" },
  { id: "messaging", labelKey: "catMessaging", icon: "chat" },
  { id: "productivity", labelKey: "catProductivity", icon: "edit_note" },
  { id: "ecommerce", labelKey: "catEcommerce", icon: "shopping_cart" },
  { id: "dev_tools", labelKey: "catDev", icon: "code" },
  { id: "analytics", labelKey: "catAnalytics", icon: "query_stats" },
  { id: "advertising", labelKey: "catAds", icon: "campaign" },
  { id: "payment", labelKey: "catPayment", icon: "payments" },
  { id: "storage", labelKey: "catStorage", icon: "cloud_upload" },
  { id: "ai_ml", labelKey: "catAi", icon: "smart_toy" },
  { id: "customer_support", labelKey: "catSupport", icon: "support_agent" },
  { id: "hr", labelKey: "catHr", icon: "groups" },
  { id: "design", labelKey: "catDesign", icon: "palette" },
  { id: "video", labelKey: "catVideo", icon: "videocam" },
  { id: "forms", labelKey: "catForms", icon: "checklist" },
  { id: "scheduling", labelKey: "catScheduling", icon: "calendar_month" },
  { id: "automation", labelKey: "catAutomation", icon: "auto_fix_high" },
];

// Status config — label resolves via t() at render
const STATUS_STYLES: Record<string, { pillClass: string; labelKey: string }> = {
  available: { pillClass: "bv-pill bv-pill-cyan",   labelKey: "statusAvailable" },
  beta:      { pillClass: "bv-pill bv-pill-purple",  labelKey: "statusBeta" },
  coming_soon: { pillClass: "bv-pill bv-pill-muted", labelKey: "statusComingSoon" },
};

// Hardcoded catalog for frontend-only rendering (no API needed)
const INTEGRATION_CATALOG = [
  // CRM
  { id: "hubspot", name: "HubSpot", category: "crm", icon: "🟠", status: "available", description: "Full CRM with contacts, deals, and pipeline management", features: ["Contact sync", "Deal tracking", "Pipeline management", "Form submissions", "Email tracking"], authType: "api_key" },
  { id: "salesforce", name: "Salesforce", category: "crm", icon: "☁️", status: "coming_soon", description: "Enterprise CRM platform for sales and service", features: ["Lead management", "Opportunity tracking", "Custom objects", "Reports", "Workflow rules"], authType: "oauth2" },
  { id: "pipedrive", name: "Pipedrive", category: "crm", icon: "🟢", status: "coming_soon", description: "Sales-focused CRM with visual pipeline", features: ["Visual pipeline", "Activity tracking", "Email integration", "Smart contact data", "Revenue forecasting"], authType: "api_key" },
  { id: "zoho_crm", name: "Zoho CRM", category: "crm", icon: "🔴", status: "coming_soon", description: "AI-powered CRM for growing businesses", features: ["Lead scoring", "Sales automation", "Analytics", "Multichannel", "Territory management"], authType: "oauth2" },
  { id: "close", name: "Close", category: "crm", icon: "🔵", status: "coming_soon", description: "CRM built for inside sales teams", features: ["Built-in calling", "Email sequences", "Pipeline reporting", "Task management", "Smart views"], authType: "api_key" },
  { id: "freshsales", name: "Freshsales", category: "crm", icon: "🟡", status: "coming_soon", description: "Modern CRM with AI-based lead scoring", features: ["AI lead scoring", "Built-in phone", "Email tracking", "Deal management", "Reports"], authType: "api_key" },
  { id: "attio", name: "Attio", category: "crm", icon: "⚡", status: "coming_soon", description: "Next-gen CRM with real-time data enrichment", features: ["Auto-enrichment", "Custom objects", "Real-time sync", "Relationship intelligence", "API-first"], authType: "api_key" },
  { id: "folk", name: "Folk", category: "crm", icon: "👥", status: "coming_soon", description: "Collaborative CRM for relationship-driven teams", features: ["Group management", "Mail merge", "Pipeline views", "Browser extension", "Enrichment"], authType: "api_key" },
  { id: "copper", name: "Copper", category: "crm", icon: "🧡", status: "coming_soon", description: "CRM designed for Google Workspace", features: ["Gmail integration", "Contact management", "Pipeline tracking", "Task automation", "Reporting"], authType: "oauth2" },
  { id: "monday_sales", name: "Monday Sales CRM", category: "crm", icon: "💜", status: "coming_soon", description: "Sales CRM on the Monday.com platform", features: ["Visual pipeline", "Email sync", "Activity tracking", "Custom dashboards", "Automations"], authType: "api_key" },

  // Social Media
  { id: "tiktok", name: "TikTok", category: "social_media", icon: "🎵", status: "available", description: "Short-form video platform", features: ["Video publishing", "Analytics", "Comment management", "Trend tracking", "Creator tools"], authType: "oauth2" },
  { id: "instagram", name: "Instagram", category: "social_media", icon: "📸", status: "available", description: "Photo and video sharing platform", features: ["Post scheduling", "Story publishing", "Reel creation", "Insights", "Comment management"], authType: "oauth2" },
  { id: "linkedin", name: "LinkedIn", category: "social_media", icon: "💼", status: "available", description: "Professional networking and content", features: ["Post publishing", "Company pages", "Analytics", "Connection management", "Article creation"], authType: "oauth2" },
  { id: "twitter", name: "Twitter / X", category: "social_media", icon: "🐦", status: "available", description: "Real-time social media platform", features: ["Tweet posting", "Thread creation", "Analytics", "DM management", "List management"], authType: "oauth2" },
  { id: "youtube", name: "YouTube", category: "social_media", icon: "🎬", status: "available", description: "Video hosting and streaming platform", features: ["Video upload", "Analytics", "Comment management", "Playlist management", "Live streaming"], authType: "oauth2" },
  { id: "facebook", name: "Facebook", category: "social_media", icon: "👤", status: "available", description: "Social media and business pages", features: ["Page posting", "Ad management", "Insights", "Group management", "Messenger"], authType: "oauth2" },
  { id: "pinterest", name: "Pinterest", category: "social_media", icon: "📌", status: "coming_soon", description: "Visual discovery and bookmarking platform", features: ["Pin creation", "Board management", "Analytics", "Rich pins", "Shopping"], authType: "oauth2" },
  { id: "reddit", name: "Reddit", category: "social_media", icon: "🤖", status: "coming_soon", description: "Community discussion platform", features: ["Post creation", "Comment tracking", "Subreddit monitoring", "Analytics", "Award management"], authType: "oauth2" },
  { id: "threads", name: "Threads", category: "social_media", icon: "🧵", status: "coming_soon", description: "Text-based conversation app by Meta", features: ["Post publishing", "Reply management", "Analytics", "Quote posts", "Reposts"], authType: "oauth2" },
  { id: "snapchat", name: "Snapchat", category: "social_media", icon: "👻", status: "coming_soon", description: "Ephemeral messaging and content", features: ["Story creation", "Snap ads", "Analytics", "Lens studio", "Spotlight"], authType: "oauth2" },

  // Email Marketing
  { id: "mailchimp", name: "Mailchimp", category: "email_marketing", icon: "🐵", status: "available", description: "All-in-one marketing platform", features: ["Email campaigns", "Automation", "Audience management", "Landing pages", "Analytics"], authType: "api_key" },
  { id: "sendgrid", name: "SendGrid", category: "email_marketing", icon: "📧", status: "available", description: "Cloud-based email delivery service", features: ["Transactional email", "Marketing campaigns", "Email validation", "Analytics", "Templates"], authType: "api_key" },
  { id: "convertkit", name: "ConvertKit", category: "email_marketing", icon: "✉️", status: "coming_soon", description: "Email marketing for creators", features: ["Visual automations", "Landing pages", "Subscriber tagging", "Broadcasts", "Commerce"], authType: "api_key" },
  { id: "activecampaign", name: "ActiveCampaign", category: "email_marketing", icon: "⚡", status: "coming_soon", description: "Customer experience automation", features: ["Email marketing", "Marketing automation", "CRM", "Messaging", "Machine learning"], authType: "api_key" },
  { id: "brevo", name: "Brevo (Sendinblue)", category: "email_marketing", icon: "💙", status: "coming_soon", description: "All-in-one digital marketing platform", features: ["Email campaigns", "SMS marketing", "Chat", "CRM", "Automation"], authType: "api_key" },
  { id: "klaviyo", name: "Klaviyo", category: "email_marketing", icon: "🎯", status: "coming_soon", description: "E-commerce marketing automation", features: ["Email flows", "SMS marketing", "Segmentation", "Predictive analytics", "A/B testing"], authType: "api_key" },
  { id: "constant_contact", name: "Constant Contact", category: "email_marketing", icon: "📬", status: "coming_soon", description: "Email marketing and online marketing", features: ["Email templates", "Contact management", "Automation", "Reporting", "Social posting"], authType: "api_key" },
  { id: "drip", name: "Drip", category: "email_marketing", icon: "💧", status: "coming_soon", description: "E-commerce CRM and marketing automation", features: ["Visual workflows", "Segmentation", "Revenue attribution", "Forms", "Integrations"], authType: "api_key" },
  { id: "beehiiv", name: "Beehiiv", category: "email_marketing", icon: "🐝", status: "coming_soon", description: "Newsletter platform for creators", features: ["Newsletter editor", "Growth tools", "Monetization", "Analytics", "Custom domains"], authType: "api_key" },
  { id: "aweber", name: "AWeber", category: "email_marketing", icon: "📮", status: "coming_soon", description: "Email marketing for small businesses", features: ["Email automation", "Landing pages", "Web push notifications", "AMP emails", "Reporting"], authType: "api_key" },

  // Messaging
  { id: "slack", name: "Slack", category: "messaging", icon: "💬", status: "available", description: "Business messaging platform", features: ["Channel messaging", "Workflows", "File sharing", "Integrations", "Search"], authType: "oauth2" },
  { id: "discord", name: "Discord", category: "messaging", icon: "🎮", status: "available", description: "Community messaging platform", features: ["Server management", "Bot integration", "Voice channels", "Thread management", "Webhooks"], authType: "api_key" },
  { id: "whatsapp", name: "WhatsApp Business", category: "messaging", icon: "💚", status: "available", description: "Business messaging on WhatsApp", features: ["Business messaging", "Catalog", "Quick replies", "Labels", "Broadcast"], authType: "api_key" },
  { id: "telegram", name: "Telegram", category: "messaging", icon: "✈️", status: "coming_soon", description: "Cloud-based messaging with bot API", features: ["Bot creation", "Channel management", "Group management", "Inline mode", "Payments"], authType: "api_key" },
  { id: "microsoft_teams", name: "Microsoft Teams", category: "messaging", icon: "🟣", status: "coming_soon", description: "Collaboration platform by Microsoft", features: ["Team messaging", "Meetings", "File collaboration", "App integration", "Workflows"], authType: "oauth2" },
  { id: "intercom", name: "Intercom", category: "messaging", icon: "🔵", status: "available", description: "Customer messaging platform", features: ["Live chat", "Chatbots", "Product tours", "Help center", "Inbox"], authType: "api_key" },
  { id: "crisp", name: "Crisp", category: "messaging", icon: "💜", status: "coming_soon", description: "Business messaging and live chat", features: ["Live chat", "Chatbot", "Knowledge base", "Status page", "CRM"], authType: "api_key" },
  { id: "drift", name: "Drift", category: "messaging", icon: "🌊", status: "coming_soon", description: "Conversational marketing platform", features: ["Live chat", "Chatbots", "Video", "Email", "Meeting scheduling"], authType: "api_key" },

  // Productivity
  { id: "notion", name: "Notion", category: "productivity", icon: "📝", status: "available", description: "All-in-one workspace for notes and docs", features: ["Pages", "Databases", "Templates", "API access", "Team collaboration"], authType: "api_key" },
  { id: "airtable", name: "Airtable", category: "productivity", icon: "📊", status: "available", description: "Spreadsheet-database hybrid", features: ["Base creation", "Views", "Automations", "Forms", "API access"], authType: "api_key" },
  { id: "google_sheets", name: "Google Sheets", category: "productivity", icon: "📗", status: "available", description: "Cloud spreadsheet by Google", features: ["Spreadsheet editing", "Formulas", "Charts", "Collaboration", "Add-ons"], authType: "oauth2" },
  { id: "google_docs", name: "Google Docs", category: "productivity", icon: "📄", status: "available", description: "Cloud document editor by Google", features: ["Document creation", "Real-time editing", "Comments", "Templates", "Add-ons"], authType: "oauth2" },
  { id: "clickup", name: "ClickUp", category: "productivity", icon: "✅", status: "coming_soon", description: "All-in-one productivity platform", features: ["Task management", "Docs", "Goals", "Time tracking", "Dashboards"], authType: "api_key" },
  { id: "asana", name: "Asana", category: "productivity", icon: "🔶", status: "coming_soon", description: "Work management platform", features: ["Task tracking", "Project views", "Portfolios", "Goals", "Automations"], authType: "oauth2" },
  { id: "trello", name: "Trello", category: "productivity", icon: "📋", status: "available", description: "Kanban-style project management", features: ["Board management", "Cards", "Checklists", "Power-Ups", "Automation"], authType: "api_key" },
  { id: "monday", name: "Monday.com", category: "productivity", icon: "💜", status: "coming_soon", description: "Work OS for teams", features: ["Boards", "Automations", "Dashboards", "Integrations", "Forms"], authType: "api_key" },
  { id: "linear", name: "Linear", category: "productivity", icon: "🔷", status: "coming_soon", description: "Issue tracking for modern teams", features: ["Issue tracking", "Cycles", "Roadmap", "Git integration", "API-first"], authType: "api_key" },
  { id: "jira", name: "Jira", category: "productivity", icon: "🔵", status: "coming_soon", description: "Project tracking for software teams", features: ["Issue tracking", "Scrum boards", "Kanban", "Roadmaps", "Reporting"], authType: "oauth2" },
  { id: "confluence", name: "Confluence", category: "productivity", icon: "📘", status: "coming_soon", description: "Team knowledge base by Atlassian", features: ["Pages", "Spaces", "Templates", "Collaboration", "Search"], authType: "oauth2" },
  { id: "coda", name: "Coda", category: "productivity", icon: "📕", status: "coming_soon", description: "All-in-one doc for teams", features: ["Docs", "Tables", "Automations", "Packs", "Publishing"], authType: "api_key" },
  { id: "basecamp", name: "Basecamp", category: "productivity", icon: "🏕️", status: "coming_soon", description: "Project management and team communication", features: ["To-dos", "Message boards", "Schedules", "Check-ins", "Hill charts"], authType: "api_key" },

  // E-Commerce
  { id: "shopify", name: "Shopify", category: "ecommerce", icon: "🛍️", status: "available", description: "E-commerce platform for online stores", features: ["Product management", "Order tracking", "Customer data", "Analytics", "Webhooks"], authType: "api_key" },
  { id: "wordpress", name: "WordPress / WooCommerce", category: "ecommerce", icon: "🌐", status: "available", description: "Open-source CMS and e-commerce", features: ["Content management", "WooCommerce", "Plugins", "REST API", "Webhooks"], authType: "api_key" },
  { id: "bigcommerce", name: "BigCommerce", category: "ecommerce", icon: "🏪", status: "coming_soon", description: "Scalable e-commerce platform", features: ["Multi-channel selling", "SEO tools", "Analytics", "B2B features", "API access"], authType: "api_key" },
  { id: "squarespace", name: "Squarespace", category: "ecommerce", icon: "◼️", status: "coming_soon", description: "Website builder with commerce", features: ["Website building", "E-commerce", "Scheduling", "Analytics", "Domains"], authType: "api_key" },
  { id: "etsy", name: "Etsy", category: "ecommerce", icon: "🧶", status: "coming_soon", description: "Marketplace for handmade and vintage", features: ["Listing management", "Order tracking", "Analytics", "Advertising", "Reviews"], authType: "api_key" },
  { id: "gumroad", name: "Gumroad", category: "ecommerce", icon: "🍬", status: "coming_soon", description: "Sell digital products directly", features: ["Digital products", "Subscriptions", "Workflows", "Analytics", "Affiliate program"], authType: "api_key" },
  { id: "lemonsqueezy", name: "Lemon Squeezy", category: "ecommerce", icon: "🍋", status: "coming_soon", description: "Merchant of record for digital products", features: ["Payments", "Subscriptions", "License keys", "Checkout", "Webhooks"], authType: "api_key" },
  { id: "paddle", name: "Paddle", category: "ecommerce", icon: "🏓", status: "coming_soon", description: "Revenue delivery platform for SaaS", features: ["Checkout", "Subscriptions", "Tax compliance", "Revenue recovery", "Analytics"], authType: "api_key" },

  // Dev Tools
  { id: "github", name: "GitHub", category: "dev_tools", icon: "🐙", status: "available", description: "Code hosting and collaboration", features: ["Repository management", "Issues", "Pull requests", "Actions", "Webhooks"], authType: "oauth2" },
  { id: "gitlab", name: "GitLab", category: "dev_tools", icon: "🦊", status: "coming_soon", description: "DevOps platform", features: ["Git repos", "CI/CD", "Issues", "Merge requests", "Container registry"], authType: "oauth2" },
  { id: "bitbucket", name: "Bitbucket", category: "dev_tools", icon: "🪣", status: "coming_soon", description: "Git code management by Atlassian", features: ["Repositories", "Pull requests", "Pipelines", "Code review", "Jira integration"], authType: "oauth2" },
  { id: "vercel", name: "Vercel", category: "dev_tools", icon: "▲", status: "coming_soon", description: "Frontend deployment platform", features: ["Deployments", "Serverless functions", "Edge network", "Analytics", "Preview URLs"], authType: "api_key" },
  { id: "netlify", name: "Netlify", category: "dev_tools", icon: "🟦", status: "coming_soon", description: "Web development and hosting platform", features: ["Deployments", "Forms", "Functions", "Identity", "Split testing"], authType: "api_key" },
  { id: "supabase", name: "Supabase", category: "dev_tools", icon: "⚡", status: "coming_soon", description: "Open-source Firebase alternative", features: ["Database", "Auth", "Storage", "Edge functions", "Realtime"], authType: "api_key" },
  { id: "firebase", name: "Firebase", category: "dev_tools", icon: "🔥", status: "coming_soon", description: "App development platform by Google", features: ["Auth", "Firestore", "Cloud functions", "Hosting", "Analytics"], authType: "api_key" },
  { id: "railway", name: "Railway", category: "dev_tools", icon: "🚂", status: "coming_soon", description: "Deploy apps with ease", features: ["Auto deploy", "Databases", "Environments", "Logs", "Metrics"], authType: "api_key" },
  { id: "render", name: "Render", category: "dev_tools", icon: "🟩", status: "coming_soon", description: "Unified cloud for apps and sites", features: ["Web services", "Static sites", "Databases", "Cron jobs", "Auto scaling"], authType: "api_key" },

  // Analytics
  { id: "google_analytics", name: "Google Analytics", category: "analytics", icon: "📈", status: "coming_soon", description: "Web analytics by Google", features: ["Traffic analysis", "User behavior", "Conversion tracking", "Custom reports", "Real-time data"], authType: "oauth2" },
  { id: "mixpanel", name: "Mixpanel", category: "analytics", icon: "🟣", status: "coming_soon", description: "Product analytics platform", features: ["Event tracking", "Funnels", "Retention", "User flows", "A/B testing"], authType: "api_key" },
  { id: "amplitude", name: "Amplitude", category: "analytics", icon: "📊", status: "coming_soon", description: "Digital analytics platform", features: ["Behavioral analytics", "Cohort analysis", "Experimentation", "Predictions", "Data governance"], authType: "api_key" },
  { id: "posthog", name: "PostHog", category: "analytics", icon: "🦔", status: "beta", description: "Open-source product analytics", features: ["Event tracking", "Session recording", "Feature flags", "Experiments", "Surveys"], authType: "api_key" },
  { id: "plausible", name: "Plausible", category: "analytics", icon: "📉", status: "coming_soon", description: "Privacy-friendly web analytics", features: ["Simple dashboard", "No cookies", "Goal tracking", "Campaigns", "API access"], authType: "api_key" },
  { id: "hotjar", name: "Hotjar", category: "analytics", icon: "🔥", status: "coming_soon", description: "Heatmaps and behavior analytics", features: ["Heatmaps", "Recordings", "Surveys", "Feedback", "Funnels"], authType: "api_key" },
  { id: "segment", name: "Segment", category: "analytics", icon: "🟢", status: "coming_soon", description: "Customer data platform", features: ["Data collection", "Data routing", "Profiles", "Audiences", "Protocols"], authType: "api_key" },

  // Advertising
  { id: "google_ads", name: "Google Ads", category: "advertising", icon: "🎯", status: "coming_soon", description: "Search and display advertising", features: ["Search campaigns", "Display ads", "Shopping ads", "Video ads", "Reporting"], authType: "oauth2" },
  { id: "meta_ads", name: "Meta Ads", category: "advertising", icon: "📘", status: "coming_soon", description: "Advertising on Facebook and Instagram", features: ["Campaign management", "Audience targeting", "Creative tools", "Pixel tracking", "Reporting"], authType: "oauth2" },
  { id: "linkedin_ads", name: "LinkedIn Ads", category: "advertising", icon: "💼", status: "coming_soon", description: "B2B advertising on LinkedIn", features: ["Sponsored content", "Message ads", "Lead gen forms", "Audience targeting", "Analytics"], authType: "oauth2" },
  { id: "tiktok_ads", name: "TikTok Ads", category: "advertising", icon: "🎵", status: "coming_soon", description: "Advertising on TikTok", features: ["In-feed ads", "TopView", "Branded effects", "Pixel tracking", "Reporting"], authType: "oauth2" },
  { id: "twitter_ads", name: "Twitter / X Ads", category: "advertising", icon: "🐦", status: "coming_soon", description: "Advertising on Twitter/X", features: ["Promoted tweets", "Follower ads", "Trend takeovers", "Targeting", "Analytics"], authType: "oauth2" },
  { id: "microsoft_ads", name: "Microsoft Ads", category: "advertising", icon: "🟦", status: "coming_soon", description: "Search advertising on Bing", features: ["Search ads", "Shopping campaigns", "Audience ads", "Import from Google", "Reporting"], authType: "api_key" },

  // Payment
  { id: "stripe", name: "Stripe", category: "payment", icon: "💳", status: "available", description: "Payment processing platform", features: ["Payments", "Subscriptions", "Invoicing", "Connect", "Radar"], authType: "api_key" },
  { id: "paypal", name: "PayPal", category: "payment", icon: "🅿️", status: "coming_soon", description: "Online payment platform", features: ["Payments", "Checkout", "Invoicing", "Subscriptions", "Disputes"], authType: "oauth2" },
  { id: "square", name: "Square", category: "payment", icon: "⬜", status: "coming_soon", description: "Payments and business tools", features: ["Payments", "POS", "Invoicing", "Banking", "Loyalty"], authType: "oauth2" },
  { id: "razorpay", name: "Razorpay", category: "payment", icon: "🔷", status: "coming_soon", description: "Payment gateway for India", features: ["Payments", "Subscriptions", "Smart Collect", "Route", "RazorpayX"], authType: "api_key" },
  { id: "wise", name: "Wise", category: "payment", icon: "🌍", status: "coming_soon", description: "International money transfers", features: ["Transfers", "Multi-currency accounts", "Batch payments", "API access", "Webhooks"], authType: "api_key" },

  // Storage
  { id: "aws_s3", name: "AWS S3", category: "storage", icon: "🪣", status: "coming_soon", description: "Amazon cloud object storage", features: ["File upload", "CDN", "Versioning", "Access control", "Events"], authType: "api_key" },
  { id: "google_cloud_storage", name: "Google Cloud Storage", category: "storage", icon: "☁️", status: "coming_soon", description: "Google cloud object storage", features: ["File storage", "CDN", "Lifecycle policies", "Access control", "Signed URLs"], authType: "api_key" },
  { id: "cloudflare_r2", name: "Cloudflare R2", category: "storage", icon: "🟠", status: "coming_soon", description: "Zero egress cost object storage", features: ["S3-compatible", "No egress fees", "Workers integration", "Auto-migration", "CDN"], authType: "api_key" },
  { id: "dropbox", name: "Dropbox", category: "storage", icon: "📦", status: "coming_soon", description: "File hosting and collaboration", features: ["File sync", "Sharing", "Team spaces", "Paper", "API access"], authType: "oauth2" },
  { id: "google_drive", name: "Google Drive", category: "storage", icon: "📁", status: "coming_soon", description: "Cloud file storage by Google", features: ["File storage", "Sharing", "Collaboration", "Search", "API access"], authType: "oauth2" },

  // AI/ML
  { id: "openai", name: "OpenAI", category: "ai_ml", icon: "🤖", status: "available", description: "GPT and DALL-E AI models", features: ["Chat completions", "Image generation", "Embeddings", "Fine-tuning", "Assistants"], authType: "api_key" },
  { id: "anthropic", name: "Anthropic Claude", category: "ai_ml", icon: "🧠", status: "available", description: "Claude AI models", features: ["Chat completions", "Tool use", "Vision", "Long context", "Batch API"], authType: "api_key" },
  { id: "google_gemini", name: "Google Gemini", category: "ai_ml", icon: "✨", status: "beta", description: "Google's multimodal AI model", features: ["Text generation", "Vision", "Code generation", "Grounding", "Function calling"], authType: "api_key" },
  { id: "mistral", name: "Mistral AI", category: "ai_ml", icon: "🌀", status: "beta", description: "Open-weight AI models", features: ["Chat completions", "Code generation", "Embeddings", "Function calling", "JSON mode"], authType: "api_key" },
  { id: "groq", name: "Groq", category: "ai_ml", icon: "⚡", status: "beta", description: "Ultra-fast inference engine", features: ["Fast inference", "Chat completions", "Tool use", "JSON mode", "Streaming"], authType: "api_key" },
  { id: "replicate", name: "Replicate", category: "ai_ml", icon: "🔄", status: "coming_soon", description: "Run ML models in the cloud", features: ["Model hosting", "Predictions", "Fine-tuning", "Webhooks", "Streaming"], authType: "api_key" },
  { id: "huggingface", name: "Hugging Face", category: "ai_ml", icon: "🤗", status: "coming_soon", description: "ML model hub and inference", features: ["Inference API", "Model hosting", "Datasets", "Spaces", "AutoTrain"], authType: "api_key" },
  { id: "elevenlabs", name: "ElevenLabs", category: "ai_ml", icon: "🔊", status: "available", description: "AI voice generation", features: ["Text-to-speech", "Voice cloning", "Voice design", "Streaming", "Dubbing"], authType: "api_key" },
  { id: "midjourney", name: "Midjourney", category: "ai_ml", icon: "🎨", status: "available", description: "AI image generation", features: ["Image generation", "Variations", "Upscaling", "Style control", "Blending"], authType: "api_key" },
  { id: "runway", name: "Runway", category: "ai_ml", icon: "🎬", status: "available", description: "AI video and creative tools", features: ["Video generation", "Image editing", "Green screen", "Motion tracking", "Inpainting"], authType: "api_key" },
  { id: "stability", name: "Stability AI", category: "ai_ml", icon: "🖼️", status: "coming_soon", description: "Stable Diffusion and more", features: ["Image generation", "Upscaling", "Inpainting", "3D generation", "API access"], authType: "api_key" },
  { id: "perplexity", name: "Perplexity", category: "ai_ml", icon: "🔍", status: "beta", description: "AI-powered search and answers", features: ["Search API", "Chat", "Citations", "Real-time data", "Structured output"], authType: "api_key" },

  // Customer Support
  { id: "zendesk", name: "Zendesk", category: "customer_support", icon: "🎧", status: "available", description: "Customer service platform", features: ["Ticketing", "Live chat", "Knowledge base", "AI agents", "Analytics"], authType: "api_key" },
  { id: "freshdesk", name: "Freshdesk", category: "customer_support", icon: "🟢", status: "coming_soon", description: "Cloud-based customer support", features: ["Ticketing", "Automation", "Knowledge base", "Community forums", "Reporting"], authType: "api_key" },
  { id: "helpscout", name: "Help Scout", category: "customer_support", icon: "🔵", status: "coming_soon", description: "Help desk for growing teams", features: ["Shared inbox", "Knowledge base", "Beacon", "Reporting", "Workflows"], authType: "api_key" },
  { id: "front", name: "Front", category: "customer_support", icon: "🟡", status: "coming_soon", description: "Customer operations platform", features: ["Shared inbox", "Workflows", "Analytics", "Integrations", "AI drafts"], authType: "api_key" },

  // HR
  { id: "bamboohr", name: "BambooHR", category: "hr", icon: "🎋", status: "coming_soon", description: "HR software for growing companies", features: ["Employee records", "Time off", "Onboarding", "Performance", "Reporting"], authType: "api_key" },
  { id: "gusto", name: "Gusto", category: "hr", icon: "💚", status: "coming_soon", description: "Payroll and HR platform", features: ["Payroll", "Benefits", "HR tools", "Hiring", "Compliance"], authType: "api_key" },
  { id: "rippling", name: "Rippling", category: "hr", icon: "🌊", status: "coming_soon", description: "Workforce management platform", features: ["HR cloud", "IT management", "Payroll", "Benefits", "Workflow automation"], authType: "api_key" },
  { id: "deel", name: "Deel", category: "hr", icon: "🌍", status: "coming_soon", description: "Global hiring and payroll", features: ["Contractor management", "EOR", "Payroll", "Compliance", "HRIS"], authType: "api_key" },
  { id: "remote", name: "Remote", category: "hr", icon: "🏠", status: "coming_soon", description: "Global employment platform", features: ["EOR", "Contractor management", "Payroll", "Benefits", "Compliance"], authType: "api_key" },

  // Design
  { id: "figma", name: "Figma", category: "design", icon: "🎨", status: "coming_soon", description: "Collaborative design tool", features: ["Design files", "Prototyping", "Dev mode", "Components", "Plugins"], authType: "oauth2" },
  { id: "canva", name: "Canva", category: "design", icon: "🖌️", status: "coming_soon", description: "Visual content creation platform", features: ["Templates", "Brand kit", "Video editing", "Collaboration", "API access"], authType: "api_key" },
  { id: "framer", name: "Framer", category: "design", icon: "🔲", status: "coming_soon", description: "Web design and publishing", features: ["Visual editor", "CMS", "Animations", "Responsive design", "Publishing"], authType: "api_key" },
  { id: "webflow", name: "Webflow", category: "design", icon: "🕸️", status: "coming_soon", description: "No-code website builder", features: ["Visual design", "CMS", "Hosting", "E-commerce", "Interactions"], authType: "api_key" },

  // Video
  { id: "loom", name: "Loom", category: "video", icon: "🎥", status: "coming_soon", description: "Async video messaging", features: ["Screen recording", "Video hosting", "Analytics", "Transcription", "Comments"], authType: "api_key" },
  { id: "vimeo", name: "Vimeo", category: "video", icon: "🔵", status: "coming_soon", description: "Professional video hosting", features: ["Video hosting", "Live streaming", "Analytics", "Player customization", "Privacy"], authType: "api_key" },
  { id: "mux", name: "Mux", category: "video", icon: "📹", status: "coming_soon", description: "Video infrastructure API", features: ["Video encoding", "Live streaming", "Thumbnails", "Analytics", "Player"], authType: "api_key" },
  { id: "cloudinary", name: "Cloudinary", category: "video", icon: "☁️", status: "coming_soon", description: "Media management platform", features: ["Image optimization", "Video processing", "Transformations", "CDN", "AI features"], authType: "api_key" },

  // Forms
  { id: "typeform", name: "Typeform", category: "forms", icon: "📝", status: "coming_soon", description: "Interactive forms and surveys", features: ["Conversational forms", "Logic jumps", "Integrations", "Analytics", "Templates"], authType: "api_key" },
  { id: "tally", name: "Tally", category: "forms", icon: "📋", status: "coming_soon", description: "Simplest way to create forms", features: ["Form builder", "Conditional logic", "File uploads", "Payments", "Webhooks"], authType: "api_key" },
  { id: "google_forms", name: "Google Forms", category: "forms", icon: "📊", status: "coming_soon", description: "Simple form builder by Google", features: ["Form creation", "Response collection", "Quiz mode", "Templates", "Sheets integration"], authType: "oauth2" },
  { id: "jotform", name: "JotForm", category: "forms", icon: "📑", status: "coming_soon", description: "Online form builder", features: ["Drag-and-drop builder", "Payment forms", "Approvals", "PDF forms", "Widgets"], authType: "api_key" },
  { id: "surveymonkey", name: "SurveyMonkey", category: "forms", icon: "🐒", status: "coming_soon", description: "Survey and feedback platform", features: ["Surveys", "Quizzes", "Polls", "Analytics", "Templates"], authType: "api_key" },

  // Scheduling
  { id: "calendly", name: "Calendly", category: "scheduling", icon: "📅", status: "available", description: "Scheduling automation", features: ["Booking pages", "Workflows", "Integrations", "Group events", "Routing"], authType: "api_key" },
  { id: "cal_com", name: "Cal.com", category: "scheduling", icon: "📆", status: "coming_soon", description: "Open-source scheduling", features: ["Booking pages", "Team scheduling", "Custom workflows", "Webhooks", "API access"], authType: "api_key" },
  { id: "savvycal", name: "SavvyCal", category: "scheduling", icon: "🗓️", status: "coming_soon", description: "Scheduling for busy people", features: ["Personalized links", "Overlay calendars", "Priority scheduling", "Workflows", "Integrations"], authType: "api_key" },
  { id: "tidycal", name: "TidyCal", category: "scheduling", icon: "⏰", status: "coming_soon", description: "Simple scheduling tool", features: ["Booking pages", "Calendar sync", "Payments", "Custom questions", "Integrations"], authType: "api_key" },

  // Automation
  { id: "zapier", name: "Zapier", category: "automation", icon: "⚡", status: "coming_soon", description: "No-code automation platform", features: ["6000+ app connections", "Multi-step zaps", "Filters", "Formatter", "Webhooks"], authType: "api_key" },
  { id: "make", name: "Make (Integromat)", category: "automation", icon: "🔮", status: "coming_soon", description: "Visual automation platform", features: ["Visual builder", "1500+ apps", "Data stores", "Webhooks", "Scheduling"], authType: "api_key" },
  { id: "n8n", name: "n8n", category: "automation", icon: "🔗", status: "coming_soon", description: "Fair-code workflow automation", features: ["Self-hostable", "400+ integrations", "Code nodes", "Webhooks", "AI capabilities"], authType: "api_key" },
  { id: "activepieces", name: "Activepieces", category: "automation", icon: "🧩", status: "coming_soon", description: "Open-source automation tool", features: ["No-code builder", "Self-hostable", "100+ pieces", "Webhooks", "Code step"], authType: "api_key" },
  { id: "pipedream", name: "Pipedream", category: "automation", icon: "🚀", status: "coming_soon", description: "Developer-first automation", features: ["Code-based workflows", "2000+ APIs", "Event sources", "Data stores", "Cron jobs"], authType: "api_key" },
];

export default function IntegrationsPage() {
  const t = useTranslations();
  const { token, hydrated } = useAuthGuard();
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtered = INTEGRATION_CATALOG.filter((c) => {
    const matchSearch = !search || c.name.toLowerCase().includes(search.toLowerCase()) || c.description.toLowerCase().includes(search.toLowerCase());
    const matchCategory = !selectedCategory || c.category === selectedCategory;
    return matchSearch && matchCategory;
  });

  const availableCount = INTEGRATION_CATALOG.filter((c) => c.status === "available").length;
  const betaCount = INTEGRATION_CATALOG.filter((c) => c.status === "beta").length;
  const totalCount = INTEGRATION_CATALOG.length;

  if (!hydrated || !token) return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="loading-dots"><span /><span /><span /></div>
    </div>
  );

  return (
    <div className="bv-dash max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 animate-fade-in">

      {/* Page head */}
      <div className="bv-page-head mb-6">
        <div>
          <p className="bv-micro mb-1 text-outline">Connections</p>
          <h1 className="bv-headline gradient-text mb-1">{t("app.integrations.title")}</h1>
          <p className="bv-caption">
            {t("app.integrations.subtitleTemplate", { total: totalCount, available: availableCount, beta: betaCount, comingSoon: totalCount - availableCount - betaCount })}
          </p>
        </div>
      </div>

      {/* Import CTA banner */}
      <div className="bv-glass bv-panel flex-row items-center gap-4 mb-6" style={{ borderStyle: "dashed" }}>
        <div
          className="flex-none w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: "rgba(59,130,246,0.10)", border: "1px solid rgba(59,130,246,0.25)" }}
        >
          <span className="material-symbols-outlined text-primary" style={{ fontSize: 20 }}>upload</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="bv-title text-on-surface">Import an existing automation</p>
          <p className="bv-caption mt-0.5">Bring an n8n, Make or Zapier export — we&apos;ll parse it into a pipeline.</p>
        </div>
        <Link href="/integrations/import" className="bv-btn bv-btn-primary bv-btn-sm flex-none" style={{ textDecoration: "none" }}>
          Import
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>arrow_forward</span>
        </Link>
      </div>

      {/* Search + filter bar */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        {/* Search input */}
        <div className="relative flex-1 max-w-sm">
          <span
            className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline"
            style={{ fontSize: 17, pointerEvents: "none" }}
          >
            search
          </span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("app.integrations.searchPlaceholder")}
            className="w-full pl-9 pr-4 py-2.5 rounded-xl text-sm outline-none bg-surface-container-low border border-outline-variant text-on-surface placeholder:text-outline focus:border-primary focus:ring-1 focus:ring-primary/20 transition-colors"
          />
        </div>
      </div>

      {/* Category filter chips */}
      <div className="bv-fpills mb-6">
        {CATEGORIES.map((cat) => {
          const count = cat.id ? INTEGRATION_CATALOG.filter((c) => c.category === cat.id).length : totalCount;
          const isActive = selectedCategory === cat.id;
          return (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id)}
              className={`bv-fpill${isActive ? " active" : ""}`}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 13 }}>{cat.icon}</span>
              {t(`app.integrations.${cat.labelKey}`)}
              <span className="bv-fpill-count">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Results count */}
      <p className="bv-micro mb-4">{t("app.integrations.resultCountTemplate", { count: filtered.length })}</p>

      {/* Integrations grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {filtered.map((connector) => {
          const statusStyle = STATUS_STYLES[connector.status] ?? STATUS_STYLES.coming_soon;
          const isExpanded = expandedId === connector.id;

          return (
            <div
              key={connector.id}
              className={`bv-glass cursor-pointer transition-all${isExpanded ? " glow-cyan" : ""}`}
              style={isExpanded ? { borderColor: "rgba(59,130,246,0.25)" } : {}}
              onClick={() => setExpandedId(isExpanded ? null : connector.id)}
            >
              <div className="p-4">
                {/* Card top row */}
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2.5">
                    {/* Integration avatar */}
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center flex-none text-lg"
                      style={{
                        background: "rgba(255,255,255,0.05)",
                        border: "1px solid rgba(255,255,255,0.08)",
                      }}
                    >
                      {connector.icon}
                    </div>
                    <div className="min-w-0">
                      <p className="bv-title text-sm truncate">{connector.name}</p>
                      <p className="bv-micro capitalize" style={{ textTransform: "none", letterSpacing: 0, fontSize: 11 }}>
                        {connector.category.replace("_", " ")}
                      </p>
                    </div>
                  </div>
                  <span className={statusStyle.pillClass}>
                    {t(`app.integrations.${statusStyle.labelKey}`)}
                  </span>
                </div>

                {/* Description */}
                <p className="bv-caption line-clamp-2 mt-2">{connector.description}</p>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="mt-3 pt-3 border-t border-outline-variant">
                    <p className="bv-micro mb-2">{t("app.integrations.features")}</p>
                    <div className="flex flex-wrap gap-1 mb-3">
                      {connector.features.map((f) => (
                        <span
                          key={f}
                          className="bv-mono text-on-surface-variant px-2 py-0.5 rounded-full"
                          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)", fontSize: 10 }}
                        >
                          {f}
                        </span>
                      ))}
                    </div>
                    <p className="bv-micro mb-3">
                      {t("app.integrations.authPrefix")}{" "}
                      <span className="text-on-surface-variant normal-case" style={{ letterSpacing: 0 }}>
                        {connector.authType.replace("_", " ").toUpperCase()}
                      </span>
                    </p>
                    {connector.status === "available" ? (
                      <Link
                        href="/connections"
                        onClick={(e) => e.stopPropagation()}
                        className="bv-btn bv-btn-primary w-full justify-center"
                        style={{ minHeight: 36, fontSize: 12, textDecoration: "none" }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>settings</span>
                        {t("app.integrations.configure")}
                      </Link>
                    ) : connector.status === "beta" ? (
                      <a
                        href={`mailto:founders@braavolabs.com?subject=${encodeURIComponent(`Beta access: ${connector.name}`)}`}
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                        className="bv-btn bv-btn-ghost w-full justify-center"
                        style={{ minHeight: 36, fontSize: 12, color: "#60A5FA", borderColor: "rgba(59,130,246,0.3)", textDecoration: "none" }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>science</span>
                        {t("app.integrations.joinBeta")}
                      </a>
                    ) : (
                      <button className="bv-btn bv-btn-ghost w-full justify-center" style={{ minHeight: 36, fontSize: 12 }} disabled>
                        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>schedule</span>
                        {t("app.integrations.comingSoonBtn")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
          >
            <span className="material-symbols-outlined text-outline" style={{ fontSize: 28 }}>search_off</span>
          </div>
          <p className="bv-body text-on-surface-variant">{t("app.integrations.noResults")}</p>
        </div>
      )}

    </div>
  );
}

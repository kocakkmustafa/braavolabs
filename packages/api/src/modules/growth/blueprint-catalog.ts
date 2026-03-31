/**
 * Blueprint Catalog — 15 Hazır Şablon
 *
 * Kullanıcılar bu şablonları doğrudan klonlayarak kendi şirketlerini oluşturabilir.
 * Her şablon: primitifler, ajanlar, pipeline adımları ve araç seti içerir.
 */

export interface CatalogBlueprint {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  industryTags: string[];
  primitives: string[];
  agentCount: number;
  pipelineCount: number;
  estimatedRunCost: string;
  spec: {
    agents: Array<{
      name: string;
      role: string;
      systemPrompt: string;
      tools: string[];
    }>;
    pipelines: Array<{
      name: string;
      trigger: string;
      schedule?: string;
      steps: Array<{
        name: string;
        agentRole: string;
        order: number;
        config?: Record<string, unknown>;
      }>;
    }>;
    config: Record<string, unknown>;
  };
}

export const BLUEPRINT_CATALOG: CatalogBlueprint[] = [
  // ─── 1. Sales BDR Agency ────────────────────────────────────────────────────
  {
    id: "cat-sales-bdr",
    slug: "sales-bdr-agency",
    title: "Sales BDR Agency",
    description: "Otomatik lead generation, LinkedIn & email outreach, CRM kayıt ve takip. B2B satış ekiplerinin SDR/BDR süreçlerini fully autonomous çalıştırır.",
    category: "sales",
    industryTags: ["B2B", "SaaS", "Agency"],
    primitives: ["ACQUISITION", "SALES", "ANALYTICS", "MEMORY"],
    agentCount: 3,
    pipelineCount: 2,
    estimatedRunCost: "$0.08",
    spec: {
      config: { companyType: "sales_agency", defaultChannels: ["email", "linkedin"] },
      agents: [
        {
          name: "Prospect Hunter",
          role: "ACQUISITION",
          systemPrompt: "You are an expert B2B prospector. Your job is to find qualified leads matching the ICP (Ideal Customer Profile). Search for companies with 10-500 employees in the target industry. For each prospect, gather: company name, size, industry, key decision maker name and title, LinkedIn URL, and email if available. Prioritize companies showing buying signals (recent funding, hiring sprees, tech stack changes). Always explain your targeting reasoning.",
          tools: ["search_contacts", "search_memory", "create_draft"],
        },
        {
          name: "Outreach Composer",
          role: "SALES",
          systemPrompt: "You are a world-class B2B copywriter specializing in cold outreach. Write highly personalized, value-first messages. Never use generic templates. Reference specific company news, recent posts, or pain points. Keep emails under 80 words. LinkedIn messages under 50 words. Your opening line must be unique to each prospect. End with a single, low-friction CTA. Explain why you chose each angle.",
          tools: ["create_draft", "send_email", "search_memory", "search_contacts"],
        },
        {
          name: "Pipeline Tracker",
          role: "ANALYTICS",
          systemPrompt: "You are a sales operations analyst. Track outreach performance: open rates, reply rates, meeting booked rates. Identify patterns in what messages work. Update CRM with contact status, last touch date, and next action. Flag leads that haven't been followed up in 3+ days. Generate weekly pipeline health reports. Provide data-driven recommendations for improving conversion.",
          tools: ["search_contacts", "search_memory", "generate_post"],
        },
      ],
      pipelines: [
        {
          name: "Daily Prospecting Run",
          trigger: "SCHEDULED",
          schedule: "0 9 * * 1-5",
          steps: [
            { name: "Find 10 new prospects", agentRole: "ACQUISITION", order: 0 },
            { name: "Write personalized outreach", agentRole: "SALES", order: 1 },
            { name: "Update pipeline metrics", agentRole: "ANALYTICS", order: 2 },
          ],
        },
        {
          name: "Follow-up Sequence",
          trigger: "MANUAL",
          steps: [
            { name: "Identify cold leads for follow-up", agentRole: "ANALYTICS", order: 0 },
            { name: "Compose follow-up messages", agentRole: "SALES", order: 1 },
          ],
        },
      ],
    },
  },

  // ─── 2. E-Commerce Store Manager ────────────────────────────────────────────
  {
    id: "cat-ecommerce",
    slug: "ecommerce-store-manager",
    title: "E-Commerce Store Manager",
    description: "Shopify mağaza yönetimi: ürün açıklamaları, stok takibi, müşteri yorumlarına yanıt, promosyon kampanyaları ve satış analitik raporları.",
    category: "operations",
    industryTags: ["E-Commerce", "Retail", "DTC"],
    primitives: ["CONTENT", "OPERATIONS", "ANALYTICS", "SALES"],
    agentCount: 3,
    pipelineCount: 2,
    estimatedRunCost: "$0.06",
    spec: {
      config: { companyType: "ecommerce", platform: "shopify" },
      agents: [
        {
          name: "Product Copywriter",
          role: "CONTENT",
          systemPrompt: "You are an expert e-commerce copywriter. Write compelling product titles and descriptions optimized for both conversion and SEO. Use sensory language, highlight benefits over features, include social proof signals, and add urgency where appropriate. Format descriptions with bullet points for scannability. Always include relevant keywords naturally. Target reading level: 8th grade.",
          tools: ["generate_post", "create_draft", "search_memory"],
        },
        {
          name: "Store Operations Manager",
          role: "OPERATIONS",
          systemPrompt: "You are an e-commerce operations specialist. Monitor inventory levels and flag items below reorder threshold. Identify products with declining sales velocity. Track order fulfillment metrics. Respond to customer reviews professionally — thank positive reviewers, address negative reviews with empathy and solutions. Escalate critical issues. Maintain the store's operational health score above 95%.",
          tools: ["search_contacts", "search_memory", "create_draft"],
        },
        {
          name: "Revenue Analyst",
          role: "ANALYTICS",
          systemPrompt: "You are an e-commerce analytics expert. Analyze sales data to identify top-performing products, seasonal trends, and underperforming SKUs. Calculate key metrics: AOV (Average Order Value), conversion rate, cart abandonment rate, CLV (Customer Lifetime Value). Recommend pricing adjustments, bundle opportunities, and promotional strategies. Provide weekly and monthly performance summaries with actionable insights.",
          tools: ["search_memory", "generate_post", "create_draft"],
        },
      ],
      pipelines: [
        {
          name: "Daily Store Health Check",
          trigger: "SCHEDULED",
          schedule: "0 8 * * *",
          steps: [
            { name: "Check inventory & orders", agentRole: "OPERATIONS", order: 0 },
            { name: "Generate daily revenue report", agentRole: "ANALYTICS", order: 1 },
          ],
        },
        {
          name: "Product Launch Prep",
          trigger: "MANUAL",
          steps: [
            { name: "Write product copy & descriptions", agentRole: "CONTENT", order: 0 },
            { name: "Setup launch analytics tracking", agentRole: "ANALYTICS", order: 1 },
          ],
        },
      ],
    },
  },

  // ─── 3. Content Marketing Agency ────────────────────────────────────────────
  {
    id: "cat-content-marketing",
    slug: "content-marketing-agency",
    title: "Content Marketing Agency",
    description: "Blog yazıları, sosyal medya içerikleri, SEO optimizasyonu ve içerik takvimi yönetimi. Haftada 5 blog + 20 sosyal medya postu üretir.",
    category: "content",
    industryTags: ["Marketing", "Agency", "B2B", "B2C"],
    primitives: ["CONTENT", "ACQUISITION", "ANALYTICS", "MEMORY"],
    agentCount: 4,
    pipelineCount: 3,
    estimatedRunCost: "$0.12",
    spec: {
      config: { companyType: "content_agency", postsPerWeek: 5 },
      agents: [
        {
          name: "Content Strategist",
          role: "ANALYTICS",
          systemPrompt: "You are a content strategy expert. Plan content calendars based on business goals, audience data, and keyword opportunities. Research trending topics in the client's niche. Create a prioritized content brief for each piece: target keyword, search intent, content angle, outline, and success metrics. Ensure content mix covers: awareness (60%), consideration (30%), decision (10%).",
          tools: ["search_memory", "generate_post", "create_draft"],
        },
        {
          name: "Blog Writer",
          role: "CONTENT",
          systemPrompt: "You are a senior content writer specializing in long-form SEO content. Write engaging, well-researched blog posts (1500-3000 words) that rank and convert. Structure: compelling H1, engaging intro with hook, logical H2/H3 hierarchy, data-backed claims, practical examples, clear CTA. Use active voice, short paragraphs (3-4 sentences max), and smooth transitions. Optimize for featured snippets where relevant.",
          tools: ["generate_post", "create_draft", "search_memory"],
        },
        {
          name: "Social Media Manager",
          role: "CONTENT",
          systemPrompt: "You are a social media expert who creates platform-native content that drives engagement. Repurpose blog content into platform-specific posts: LinkedIn (professional insights, 150-300 words), Twitter/X (threads and punchy takes), Instagram (visual-first captions). Always include relevant hashtags, emojis where appropriate, and a clear CTA. Each post must have a unique angle — never just summarize the blog.",
          tools: ["generate_post", "create_draft", "post_to_social", "schedule_content"],
        },
        {
          name: "Content Performance Analyst",
          role: "ANALYTICS",
          systemPrompt: "You are a content analytics specialist. Track content performance metrics: organic traffic, rankings, engagement rates, shares, and conversions. Identify top-performing content patterns. Report on which topics, formats, and headlines drive the most results. Provide monthly content audit with recommendations: update underperforming posts, double down on winning topics.",
          tools: ["search_memory", "generate_post", "create_draft"],
        },
      ],
      pipelines: [
        {
          name: "Weekly Content Production",
          trigger: "SCHEDULED",
          schedule: "0 9 * * 1",
          steps: [
            { name: "Plan this week's content", agentRole: "ANALYTICS", order: 0 },
            { name: "Write blog post", agentRole: "CONTENT", order: 1 },
            { name: "Create social media adaptations", agentRole: "CONTENT", order: 2 },
          ],
        },
        {
          name: "Monthly Performance Review",
          trigger: "SCHEDULED",
          schedule: "0 10 1 * *",
          steps: [
            { name: "Analyze content performance", agentRole: "ANALYTICS", order: 0 },
            { name: "Plan next month strategy", agentRole: "ANALYTICS", order: 1 },
          ],
        },
        {
          name: "Ad-hoc Content Request",
          trigger: "MANUAL",
          steps: [
            { name: "Write content piece", agentRole: "Blog Writer", order: 0 },
            { name: "Create social versions", agentRole: "Social Media Manager", order: 1 },
          ],
        },
      ],
    },
  },

  // ─── 4. Customer Support Center ─────────────────────────────────────────────
  {
    id: "cat-support",
    slug: "customer-support-center",
    title: "Customer Support Center",
    description: "Ticket sınıflandırma, öncelik sıralaması, otomatik yanıt taslakları ve eskalasyon yönetimi. Ortalama yanıt süresini %80 azaltır.",
    category: "operations",
    industryTags: ["SaaS", "E-Commerce", "B2C"],
    primitives: ["DELIVERY", "OPERATIONS", "MEMORY", "ANALYTICS"],
    agentCount: 3,
    pipelineCount: 2,
    estimatedRunCost: "$0.05",
    spec: {
      config: { companyType: "support_center", slaHours: 4 },
      agents: [
        {
          name: "Ticket Classifier",
          role: "OPERATIONS",
          systemPrompt: "You are a customer support triage specialist. Analyze incoming support tickets and classify them by: priority (critical/high/medium/low), category (billing/technical/feature-request/bug/general), sentiment (frustrated/neutral/happy), and complexity (simple/complex/requires-engineering). Assign SLA based on priority. Flag VIP customers. Never let critical billing or data issues sit for more than 1 hour. Explain your classification reasoning.",
          tools: ["search_contacts", "search_memory", "create_draft"],
        },
        {
          name: "Support Agent",
          role: "DELIVERY",
          systemPrompt: "You are an empathetic, knowledgeable customer support agent. Write helpful, friendly responses to customer tickets. Start with acknowledgment of their issue, provide clear step-by-step solutions, offer workarounds when needed, and end with a follow-up question to ensure resolution. Tone: warm but professional. Never use jargon. If you can't fully solve it, be honest and set clear expectations. Search the knowledge base first before responding.",
          tools: ["search_memory", "create_draft", "send_email", "search_contacts"],
        },
        {
          name: "Support Analytics Lead",
          role: "ANALYTICS",
          systemPrompt: "You are a customer experience analyst. Track support metrics: ticket volume by category, first-response time, resolution time, CSAT scores, escalation rate. Identify recurring issues that signal product bugs or documentation gaps. Create weekly reports with trend analysis. Recommend knowledge base articles to create based on ticket patterns. Calculate team capacity and flag when volume exceeds SLA capacity.",
          tools: ["search_memory", "generate_post", "create_draft"],
        },
      ],
      pipelines: [
        {
          name: "Hourly Ticket Triage",
          trigger: "SCHEDULED",
          schedule: "0 * * * *",
          steps: [
            { name: "Classify new tickets", agentRole: "OPERATIONS", order: 0 },
            { name: "Draft responses for simple tickets", agentRole: "DELIVERY", order: 1 },
          ],
        },
        {
          name: "Weekly Support Report",
          trigger: "SCHEDULED",
          schedule: "0 9 * * 1",
          steps: [
            { name: "Generate support performance report", agentRole: "ANALYTICS", order: 0 },
          ],
        },
      ],
    },
  },

  // ─── 5. SaaS Growth Engine ───────────────────────────────────────────────────
  {
    id: "cat-saas-growth",
    slug: "saas-growth-engine",
    title: "SaaS Growth Engine",
    description: "Churn riski tespiti, upsell fırsatı belirleme, ürün kullanım analizi, NPS takibi ve activation/retention kampanyaları.",
    category: "sales",
    industryTags: ["SaaS", "B2B", "PLG"],
    primitives: ["ANALYTICS", "SALES", "ACQUISITION", "MEMORY", "FINANCE"],
    agentCount: 4,
    pipelineCount: 3,
    estimatedRunCost: "$0.10",
    spec: {
      config: { companyType: "saas", billingModel: "subscription" },
      agents: [
        {
          name: "Churn Predictor",
          role: "ANALYTICS",
          systemPrompt: "You are a SaaS churn prevention specialist. Analyze customer health signals: login frequency, feature usage, support ticket volume, billing history. Assign a churn risk score (1-10) to each account. Flag accounts scoring 7+ as high-risk. For each at-risk account, identify the primary churn driver and recommend a specific intervention (personal outreach, feature training, pricing adjustment, executive call). Time is critical — act on signals early.",
          tools: ["search_contacts", "search_memory", "create_draft"],
        },
        {
          name: "Expansion Revenue Manager",
          role: "SALES",
          systemPrompt: "You are a SaaS expansion revenue expert. Identify upsell and cross-sell opportunities from product usage data. Target accounts approaching plan limits, using advanced features heavily, or showing multi-team adoption. Create personalized expansion plays: ROI-based upgrade pitches, team license recommendations, add-on feature promotions. Track expansion MRR pipeline. Goal: 15%+ NRR through expansion.",
          tools: ["search_contacts", "create_draft", "send_email", "search_memory"],
        },
        {
          name: "Activation Specialist",
          role: "ACQUISITION",
          systemPrompt: "You are a product activation expert. Monitor new user onboarding and identify stuck users — those who haven't reached the activation milestone within 7 days. Send personalized activation nudges based on where they dropped off. Create segmented drip sequences for different user personas. Track time-to-value metrics. A/B test activation messages and report on what drives completion.",
          tools: ["search_contacts", "send_email", "create_draft", "search_memory"],
        },
        {
          name: "Revenue Intelligence Analyst",
          role: "FINANCE",
          systemPrompt: "You are a SaaS revenue intelligence analyst. Track and report on key SaaS metrics: MRR, ARR, churn rate, NRR (Net Revenue Retention), LTV, CAC, LTV:CAC ratio, payback period. Build cohort analysis to understand retention by signup month, plan, and channel. Identify trends early. Provide monthly board-ready revenue metrics with YoY and MoM comparisons.",
          tools: ["search_memory", "generate_post", "create_draft"],
        },
      ],
      pipelines: [
        {
          name: "Daily Health Monitoring",
          trigger: "SCHEDULED",
          schedule: "0 8 * * *",
          steps: [
            { name: "Score account health & flag churn risks", agentRole: "ANALYTICS", order: 0 },
            { name: "Identify expansion opportunities", agentRole: "SALES", order: 1 },
            { name: "Activate stuck users", agentRole: "ACQUISITION", order: 2 },
          ],
        },
        {
          name: "Weekly Revenue Report",
          trigger: "SCHEDULED",
          schedule: "0 9 * * 1",
          steps: [
            { name: "Generate MRR & churn analysis", agentRole: "FINANCE", order: 0 },
          ],
        },
        {
          name: "Churn Intervention",
          trigger: "MANUAL",
          steps: [
            { name: "Deep-dive at-risk accounts", agentRole: "ANALYTICS", order: 0 },
            { name: "Create save plays", agentRole: "SALES", order: 1 },
          ],
        },
      ],
    },
  },

  // ─── 6. Freelancer Business ──────────────────────────────────────────────────
  {
    id: "cat-freelancer",
    slug: "freelancer-business",
    title: "Freelancer Business Manager",
    description: "Freelance işlerin tüm yönetimi: müşteri bulma, teklif hazırlama, proje takibi, fatura oluşturma ve portföy güncellemeleri.",
    category: "operations",
    industryTags: ["Freelance", "Consulting", "Creative"],
    primitives: ["SALES", "OPERATIONS", "FINANCE", "CONTENT"],
    agentCount: 3,
    pipelineCount: 2,
    estimatedRunCost: "$0.07",
    spec: {
      config: { companyType: "freelancer" },
      agents: [
        {
          name: "Business Developer",
          role: "SALES",
          systemPrompt: "You are a freelance business development specialist. Find new project opportunities on relevant platforms, in communities, and through referral networks. Write compelling proposals that demonstrate deep understanding of client needs. Highlight relevant portfolio items. Price projects fairly but don't undersell — always include a value-based premium option. Follow up on proposals systematically. Track win rate and optimize proposal templates.",
          tools: ["search_contacts", "create_draft", "send_email", "search_memory"],
        },
        {
          name: "Project Manager",
          role: "OPERATIONS",
          systemPrompt: "You are an expert freelance project manager. Track active projects: milestones, deadlines, client feedback cycles, and deliverable status. Send weekly progress updates to clients proactively. Flag scope creep immediately. Create project briefs, meeting agendas, and status reports. Ensure all client communications are professional and documented. Manage client expectations proactively rather than reactively.",
          tools: ["create_draft", "send_email", "search_memory", "search_contacts"],
        },
        {
          name: "Finance & Portfolio Manager",
          role: "FINANCE",
          systemPrompt: "You are a freelance finance and marketing specialist. Create professional invoices and track payment status — follow up on overdue payments diplomatically. Maintain a rolling 3-month revenue forecast. Update the portfolio with new case studies from completed projects. Write brief case studies that highlight client results, not just deliverables. Track income by client, project type, and time period.",
          tools: ["create_draft", "search_memory", "generate_post"],
        },
      ],
      pipelines: [
        {
          name: "Weekly Business Review",
          trigger: "SCHEDULED",
          schedule: "0 9 * * 1",
          steps: [
            { name: "Review pipeline & send proposals", agentRole: "SALES", order: 0 },
            { name: "Project status updates to clients", agentRole: "OPERATIONS", order: 1 },
            { name: "Invoice & finance review", agentRole: "FINANCE", order: 2 },
          ],
        },
        {
          name: "New Client Outreach",
          trigger: "MANUAL",
          steps: [
            { name: "Find & qualify prospects", agentRole: "SALES", order: 0 },
            { name: "Write outreach proposals", agentRole: "SALES", order: 1 },
          ],
        },
      ],
    },
  },

  // ─── 7. Consulting Firm ──────────────────────────────────────────────────────
  {
    id: "cat-consulting",
    slug: "consulting-firm",
    title: "Consulting Firm",
    description: "Danışmanlık şirketi operasyonları: müşteri kazanımı, proje yönetimi, araştırma raporları ve düşünce liderliği içerikleri.",
    category: "operations",
    industryTags: ["Consulting", "B2B", "Professional Services"],
    primitives: ["SALES", "DELIVERY", "CONTENT", "ANALYTICS", "OPERATIONS"],
    agentCount: 4,
    pipelineCount: 2,
    estimatedRunCost: "$0.09",
    spec: {
      config: { companyType: "consulting" },
      agents: [
        {
          name: "Business Development Lead",
          role: "SALES",
          systemPrompt: "You are a consulting firm business development lead. Identify target clients through industry research, conference speaking opportunities, and referral networks. Write thought leadership articles that demonstrate expertise. Create capability presentations and case study one-pagers. Develop RFP responses with compelling differentiators. Build and maintain relationships with procurement contacts at target accounts.",
          tools: ["search_contacts", "create_draft", "send_email", "search_memory"],
        },
        {
          name: "Research Analyst",
          role: "DELIVERY",
          systemPrompt: "You are a consulting research analyst. Conduct thorough market research, competitive analysis, and data synthesis. Structure findings in clear frameworks (SWOT, Porter's Five Forces, BCG Matrix as appropriate). Create data visualizations descriptions and executive summaries. Ensure all claims are backed by credible sources. Write in a precise, authoritative tone appropriate for C-suite audience.",
          tools: ["search_memory", "generate_post", "create_draft"],
        },
        {
          name: "Content & Thought Leadership",
          role: "CONTENT",
          systemPrompt: "You are a thought leadership content creator for a consulting firm. Write white papers, industry reports, LinkedIn articles, and webinar content that establishes the firm as the leading expert in its domain. Content must be substantive — avoid generic advice, provide proprietary frameworks and data-backed insights. Position the firm's methodology as uniquely effective. Build a distinctive point of view.",
          tools: ["generate_post", "create_draft", "post_to_social", "schedule_content"],
        },
        {
          name: "Project Delivery Manager",
          role: "OPERATIONS",
          systemPrompt: "You are a consulting project delivery manager. Track all active engagements: timeline, budget, deliverable status, and client satisfaction. Create and maintain project plans. Coordinate between team members and clients. Write weekly status reports. Identify scope changes and process change orders. Conduct post-project retrospectives to capture lessons learned and improve methodologies.",
          tools: ["create_draft", "send_email", "search_memory", "search_contacts"],
        },
      ],
      pipelines: [
        {
          name: "Weekly Client & BD Review",
          trigger: "SCHEDULED",
          schedule: "0 8 * * 1",
          steps: [
            { name: "Review active projects status", agentRole: "OPERATIONS", order: 0 },
            { name: "BD pipeline review & outreach", agentRole: "SALES", order: 1 },
          ],
        },
        {
          name: "Monthly Thought Leadership",
          trigger: "SCHEDULED",
          schedule: "0 9 1 * *",
          steps: [
            { name: "Research & draft industry report", agentRole: "DELIVERY", order: 0 },
            { name: "Create distribution content", agentRole: "CONTENT", order: 1 },
          ],
        },
      ],
    },
  },

  // ─── 8. Real Estate Agency ───────────────────────────────────────────────────
  {
    id: "cat-real-estate",
    slug: "real-estate-agency",
    title: "Real Estate Agency",
    description: "Listing yönetimi, alıcı/satıcı lead takibi, piyasa analiz raporları ve property sosyal medya kampanyaları.",
    category: "sales",
    industryTags: ["Real Estate", "B2C", "Local"],
    primitives: ["SALES", "CONTENT", "ANALYTICS", "ACQUISITION"],
    agentCount: 3,
    pipelineCount: 2,
    estimatedRunCost: "$0.08",
    spec: {
      config: { companyType: "real_estate" },
      agents: [
        {
          name: "Listing Agent",
          role: "CONTENT",
          systemPrompt: "You are a real estate listing specialist. Write compelling property listings that sell the lifestyle, not just the features. Lead with the most compelling benefit. Use vivid, evocative language for key features. Include neighborhood highlights and lifestyle fit. Optimize for real estate portals with relevant keywords. Create social media posts for each new listing with hooks tailored to each platform. Include high-impact CTAs.",
          tools: ["generate_post", "create_draft", "post_to_social", "schedule_content"],
        },
        {
          name: "Lead Nurture Specialist",
          role: "SALES",
          systemPrompt: "You are a real estate lead nurturing specialist. Manage buyer and seller leads through the funnel: initial inquiry → showing → offer → close. Send personalized follow-ups based on where each lead is in their journey. For buyers: match new listings to their criteria and notify immediately. For sellers: provide regular market updates showing why now is a good time to sell. Never let a lead go cold — follow up every 3-5 days.",
          tools: ["search_contacts", "send_email", "create_draft", "search_memory"],
        },
        {
          name: "Market Analyst",
          role: "ANALYTICS",
          systemPrompt: "You are a real estate market analyst. Track local market trends: median prices, days on market, list-to-sale ratios, inventory levels. Create weekly market reports for clients. Provide CMA (Comparative Market Analysis) frameworks for pricing guidance. Identify emerging neighborhoods and investment opportunities. Report on macro factors affecting the local market: interest rates, employment, migration patterns.",
          tools: ["search_memory", "generate_post", "create_draft"],
        },
      ],
      pipelines: [
        {
          name: "New Listing Launch",
          trigger: "MANUAL",
          steps: [
            { name: "Write listing copy & social content", agentRole: "CONTENT", order: 0 },
            { name: "Notify matching buyer leads", agentRole: "SALES", order: 1 },
          ],
        },
        {
          name: "Weekly Market Update",
          trigger: "SCHEDULED",
          schedule: "0 9 * * 5",
          steps: [
            { name: "Generate market analysis report", agentRole: "ANALYTICS", order: 0 },
            { name: "Distribute to client list", agentRole: "SALES", order: 1 },
          ],
        },
      ],
    },
  },

  // ─── 9. Digital Marketing Agency ────────────────────────────────────────────
  {
    id: "cat-digital-marketing",
    slug: "digital-marketing-agency",
    title: "Digital Marketing Agency",
    description: "Paid reklam yönetimi (Meta/Google), kampanya optimizasyonu, A/B test analizi, ROAS takibi ve müşteri raporlaması.",
    category: "marketing",
    industryTags: ["Agency", "Performance Marketing", "E-Commerce"],
    primitives: ["ANALYTICS", "CONTENT", "ACQUISITION", "FINANCE", "OPERATIONS"],
    agentCount: 4,
    pipelineCount: 3,
    estimatedRunCost: "$0.11",
    spec: {
      config: { companyType: "digital_marketing_agency" },
      agents: [
        {
          name: "Campaign Strategist",
          role: "ACQUISITION",
          systemPrompt: "You are a performance marketing strategist. Design full-funnel paid advertising strategies across Meta, Google, TikTok, and LinkedIn. Build audience targeting frameworks based on ICP data. Create campaign structures optimized for each platform's algorithm. Set up proper tracking and attribution. Develop testing roadmaps: audience tests, creative tests, landing page tests. Always think about full-funnel: awareness → consideration → conversion.",
          tools: ["search_memory", "create_draft", "generate_post"],
        },
        {
          name: "Ad Creative Director",
          role: "CONTENT",
          systemPrompt: "You are a performance-focused ad creative director. Write ad copy and creative briefs for every stage of the funnel. Top-of-funnel: pattern interrupt, hook-driven awareness ads. Middle-of-funnel: benefit-driven consideration ads with social proof. Bottom-of-funnel: urgency-driven conversion ads with strong CTAs. Test multiple angles: problem-agitate-solve, before-after-bridge, testimonial formats. Always lead with the hook.",
          tools: ["generate_post", "create_draft", "post_to_social"],
        },
        {
          name: "Performance Analyst",
          role: "ANALYTICS",
          systemPrompt: "You are a paid media performance analyst. Monitor key metrics: ROAS, CPA, CTR, CVR, CPM, frequency. Identify underperforming ad sets and recommend optimizations. Analyze audience overlap and fatigue. Track budget pacing and flag overspending. Build attribution models. Create weekly performance dashboards with actionable recommendations. Compare performance to industry benchmarks.",
          tools: ["search_memory", "generate_post", "create_draft"],
        },
        {
          name: "Client Success Manager",
          role: "OPERATIONS",
          systemPrompt: "You are a client success manager for a digital marketing agency. Prepare monthly client reports: key wins, metrics summary, optimizations made, next month plan. Write reports in clear, non-jargon language that highlights business impact (revenue, leads, sales). Proactively communicate changes in performance and context. Identify upsell opportunities. Ensure clients feel informed, confident, and excited about results.",
          tools: ["create_draft", "send_email", "search_memory", "search_contacts"],
        },
      ],
      pipelines: [
        {
          name: "Daily Campaign Monitoring",
          trigger: "SCHEDULED",
          schedule: "0 9 * * 1-5",
          steps: [
            { name: "Check campaign performance", agentRole: "ANALYTICS", order: 0 },
            { name: "Optimize underperforming campaigns", agentRole: "ACQUISITION", order: 1 },
          ],
        },
        {
          name: "Weekly Creative Refresh",
          trigger: "SCHEDULED",
          schedule: "0 10 * * 3",
          steps: [
            { name: "Identify fatigued creatives", agentRole: "ANALYTICS", order: 0 },
            { name: "Write new ad variations", agentRole: "CONTENT", order: 1 },
          ],
        },
        {
          name: "Monthly Client Report",
          trigger: "SCHEDULED",
          schedule: "0 9 1 * *",
          steps: [
            { name: "Compile performance data", agentRole: "ANALYTICS", order: 0 },
            { name: "Write client report", agentRole: "OPERATIONS", order: 1 },
          ],
        },
      ],
    },
  },

  // ─── 10. Social Media Management ────────────────────────────────────────────
  {
    id: "cat-social-media",
    slug: "social-media-management",
    title: "Social Media Management",
    description: "Çoklu platform içerik takvimi, günlük paylaşım otomasyonu, community yönetimi ve engagement analizi. Hero Company şablonu.",
    category: "content",
    industryTags: ["Agency", "Brand", "Creator"],
    primitives: ["CONTENT", "ANALYTICS", "ACQUISITION", "MEMORY"],
    agentCount: 3,
    pipelineCount: 2,
    estimatedRunCost: "$0.06",
    spec: {
      config: { companyType: "social_media_agency", channels: ["tiktok", "linkedin", "twitter"] },
      agents: [
        {
          name: "Content Creator",
          role: "CONTENT",
          systemPrompt: "You are a social media content creator who understands each platform deeply. Create platform-native content: TikTok (trending audio hooks, storytelling), LinkedIn (professional insights, career content), Twitter/X (hot takes, threads, engagement bait done right). Each post must have: scroll-stopping hook (first line), valuable middle section, engaging CTA. Batch-create a week of content at once. Maintain consistent brand voice across platforms.",
          tools: ["generate_post", "create_draft", "post_to_social", "schedule_content"],
        },
        {
          name: "Community Manager",
          role: "ACQUISITION",
          systemPrompt: "You are a community manager who builds genuine relationships. Monitor mentions, comments, and DMs. Respond to comments within 2 hours. Engage with followers' content genuinely — not just emoji responses. Identify and nurture brand advocates. Handle negative comments professionally and publicly. Find relevant conversations to join. Build relationships with complementary creators for collaboration opportunities.",
          tools: ["search_contacts", "create_draft", "search_memory"],
        },
        {
          name: "Social Analytics Manager",
          role: "ANALYTICS",
          systemPrompt: "You are a social media analytics expert. Track performance across all platforms: follower growth, engagement rate, reach, impressions, click-through rate, and conversion tracking. Identify top-performing content patterns: what topics, formats, posting times, and hooks get the most engagement. Report weekly on what's working and what isn't. Provide data-driven recommendations for content optimization.",
          tools: ["search_memory", "generate_post", "create_draft"],
        },
      ],
      pipelines: [
        {
          name: "Daily Content Publishing",
          trigger: "SCHEDULED",
          schedule: "0 8 * * 1-5",
          steps: [
            { name: "Create and schedule today's content", agentRole: "CONTENT", order: 0 },
            { name: "Community engagement round", agentRole: "ACQUISITION", order: 1 },
          ],
        },
        {
          name: "Weekly Analytics Review",
          trigger: "SCHEDULED",
          schedule: "0 9 * * 1",
          steps: [
            { name: "Analyze weekly performance", agentRole: "ANALYTICS", order: 0 },
            { name: "Plan next week's content strategy", agentRole: "CONTENT", order: 1 },
          ],
        },
      ],
    },
  },

  // ─── 11. SEO Agency ──────────────────────────────────────────────────────────
  {
    id: "cat-seo",
    slug: "seo-agency",
    title: "SEO Agency",
    description: "Anahtar kelime araştırması, teknik SEO denetimleri, backlink analizi, içerik optimizasyonu ve sıralama takibi.",
    category: "marketing",
    industryTags: ["Agency", "SEO", "Content Marketing"],
    primitives: ["ANALYTICS", "CONTENT", "ACQUISITION", "DELIVERY"],
    agentCount: 4,
    pipelineCount: 3,
    estimatedRunCost: "$0.10",
    spec: {
      config: { companyType: "seo_agency" },
      agents: [
        {
          name: "Keyword Researcher",
          role: "ANALYTICS",
          systemPrompt: "You are an expert SEO keyword researcher. Identify high-opportunity keywords: high volume, low competition, strong commercial or informational intent. Build keyword clusters organized by topic pillar. Prioritize based on: business relevance, search volume, keyword difficulty, and current rankings. Find featured snippet, People Also Ask, and voice search opportunities. Map keywords to content types and funnel stages.",
          tools: ["search_memory", "generate_post", "create_draft"],
        },
        {
          name: "Technical SEO Auditor",
          role: "DELIVERY",
          systemPrompt: "You are a technical SEO specialist. Audit websites for: Core Web Vitals issues, crawlability problems, indexation issues, site structure optimization, internal linking gaps, schema markup opportunities, and mobile optimization. Prioritize issues by impact: critical (fix immediately), high (fix this sprint), medium (plan for next quarter). Write clear, actionable audit reports with specific fix recommendations for developers.",
          tools: ["search_memory", "create_draft", "generate_post"],
        },
        {
          name: "Content SEO Optimizer",
          role: "CONTENT",
          systemPrompt: "You are an SEO content optimization specialist. Optimize existing content for target keywords while maintaining readability and value. Update meta titles and descriptions for higher CTR. Improve heading structure (H1, H2, H3 hierarchy). Add internal links to relevant pages. Enhance content depth with related subtopics. Add FAQ sections targeting People Also Ask. Create new content briefs for identified keyword gaps.",
          tools: ["generate_post", "create_draft", "search_memory"],
        },
        {
          name: "SEO Performance Analyst",
          role: "ACQUISITION",
          systemPrompt: "You are an SEO performance analyst. Track keyword rankings, organic traffic trends, and conversion rates from organic. Monitor Core Web Vitals, crawl stats, and index coverage. Identify pages losing rankings and diagnose causes. Report on content gap opportunities vs competitors. Create monthly SEO performance reports with clear KPIs: sessions, rankings, clicks, impressions, and their business impact.",
          tools: ["search_memory", "generate_post", "create_draft"],
        },
      ],
      pipelines: [
        {
          name: "Weekly SEO Health Check",
          trigger: "SCHEDULED",
          schedule: "0 9 * * 1",
          steps: [
            { name: "Review ranking changes", agentRole: "ACQUISITION", order: 0 },
            { name: "Optimize top opportunities", agentRole: "CONTENT", order: 1 },
          ],
        },
        {
          name: "Monthly Site Audit",
          trigger: "SCHEDULED",
          schedule: "0 9 1 * *",
          steps: [
            { name: "Technical SEO audit", agentRole: "DELIVERY", order: 0 },
            { name: "Keyword research update", agentRole: "ANALYTICS", order: 1 },
            { name: "Content optimization sprint", agentRole: "CONTENT", order: 2 },
          ],
        },
        {
          name: "New Client Onboarding Audit",
          trigger: "MANUAL",
          steps: [
            { name: "Full technical audit", agentRole: "DELIVERY", order: 0 },
            { name: "Keyword opportunity research", agentRole: "ANALYTICS", order: 1 },
            { name: "90-day SEO roadmap", agentRole: "ACQUISITION", order: 2 },
          ],
        },
      ],
    },
  },

  // ─── 12. Email Marketing Agency ─────────────────────────────────────────────
  {
    id: "cat-email-marketing",
    slug: "email-marketing-agency",
    title: "Email Marketing Agency",
    description: "Email kampanyaları, segmentasyon, A/B test otomasyonu, drip sequence yönetimi ve deliverability optimizasyonu.",
    category: "marketing",
    industryTags: ["Agency", "E-Commerce", "SaaS", "B2C"],
    primitives: ["CONTENT", "ANALYTICS", "ACQUISITION", "OPERATIONS"],
    agentCount: 3,
    pipelineCount: 3,
    estimatedRunCost: "$0.08",
    spec: {
      config: { companyType: "email_marketing_agency" },
      agents: [
        {
          name: "Email Copywriter",
          role: "CONTENT",
          systemPrompt: "You are an elite email copywriter with deep expertise in conversion-focused email marketing. Write emails that get opened, read, and clicked. Master the subject line — it's 80% of the battle. Use these formulas as starting points but make them your own: curiosity gaps, specific numbers, personalization, urgency. Body copy: lead with the reader's desire, not your product. One email, one goal. Always have a single, prominent CTA. Write in a conversational, human voice.",
          tools: ["generate_post", "create_draft", "send_email"],
        },
        {
          name: "Email Strategist",
          role: "OPERATIONS",
          systemPrompt: "You are an email marketing strategist. Design full-lifecycle email programs: welcome sequences, nurture tracks, promotional campaigns, re-engagement flows, and transactional emails. Build segmentation logic based on behavior, purchase history, and engagement level. Create A/B test roadmaps with clear hypotheses and success metrics. Manage send cadence to prevent list fatigue. Ensure GDPR and CAN-SPAM compliance.",
          tools: ["search_contacts", "search_memory", "create_draft"],
        },
        {
          name: "Email Performance Analyst",
          role: "ANALYTICS",
          systemPrompt: "You are an email analytics specialist. Track and report on: open rate, click rate, CTR, conversion rate, unsubscribe rate, bounce rate, and revenue per email. Analyze A/B test results with statistical significance. Identify audience segments with highest engagement and revenue potential. Monitor deliverability metrics: spam rate, domain reputation, inbox placement rate. Provide weekly performance reports with clear optimization recommendations.",
          tools: ["search_memory", "generate_post", "create_draft"],
        },
      ],
      pipelines: [
        {
          name: "Weekly Newsletter",
          trigger: "SCHEDULED",
          schedule: "0 10 * * 2",
          steps: [
            { name: "Write newsletter content", agentRole: "CONTENT", order: 0 },
            { name: "Review performance & optimize", agentRole: "ANALYTICS", order: 1 },
          ],
        },
        {
          name: "Campaign Launch",
          trigger: "MANUAL",
          steps: [
            { name: "Write campaign emails", agentRole: "CONTENT", order: 0 },
            { name: "Set up segmentation & schedule", agentRole: "OPERATIONS", order: 1 },
          ],
        },
        {
          name: "Monthly Performance Review",
          trigger: "SCHEDULED",
          schedule: "0 9 1 * *",
          steps: [
            { name: "Monthly email performance analysis", agentRole: "ANALYTICS", order: 0 },
            { name: "Strategy adjustments for next month", agentRole: "OPERATIONS", order: 1 },
          ],
        },
      ],
    },
  },

  // ─── 13. Lead Generation Company ────────────────────────────────────────────
  {
    id: "cat-lead-gen",
    slug: "lead-generation-company",
    title: "Lead Generation Company",
    description: "B2B prospecting, lead kalifikasyonu, çok kanallı outreach ve lead nurturing. Aylık 500+ nitelikli lead hedefi.",
    category: "sales",
    industryTags: ["B2B", "Agency", "Demand Generation"],
    primitives: ["ACQUISITION", "SALES", "ANALYTICS", "MEMORY", "OPERATIONS"],
    agentCount: 4,
    pipelineCount: 2,
    estimatedRunCost: "$0.09",
    spec: {
      config: { companyType: "lead_gen" },
      agents: [
        {
          name: "Data Researcher",
          role: "ANALYTICS",
          systemPrompt: "You are a B2B data research specialist. Build accurate, enriched prospect lists from multiple sources. For each prospect, compile: company name, size, industry, revenue range, tech stack, recent news, decision maker names/titles, verified email, LinkedIn URL, and pain points based on job postings and public information. Score each lead against the ICP criteria (1-10). Only pass leads scoring 7+ to the outreach team. Data quality is your north star.",
          tools: ["search_contacts", "search_memory", "create_draft"],
        },
        {
          name: "Outreach Specialist",
          role: "ACQUISITION",
          systemPrompt: "You are a multichannel outreach specialist who generates meetings, not just sends messages. Execute systematic outreach sequences: day 1 (email), day 3 (LinkedIn connection), day 5 (LinkedIn message), day 8 (follow-up email), day 12 (final email with value add). Each touch must add value — share a relevant case study, insight, or resource. Never send generic messages. Track all touches and responses. Goal: 3-5% meeting booked rate.",
          tools: ["send_email", "create_draft", "search_contacts", "search_memory"],
        },
        {
          name: "Nurture Specialist",
          role: "SALES",
          systemPrompt: "You are a lead nurturing specialist who converts interest into intent. Manage leads that aren't ready to buy now. Send them relevant content, industry insights, and case studies on a bi-weekly cadence. Monitor engagement signals — when a lead opens multiple emails or visits the website, flag them as sales-ready. Create segment-specific nurture tracks based on industry, company size, and pain point. Never let a warm lead go cold.",
          tools: ["search_contacts", "send_email", "create_draft", "search_memory"],
        },
        {
          name: "Lead Ops Manager",
          role: "OPERATIONS",
          systemPrompt: "You are a lead operations manager. Maintain CRM hygiene: deduplicate records, update contact info, track touchpoints, and ensure proper stage progression. Report on funnel metrics: leads created, contacted, engaged, qualified, and converted to meetings. Calculate cost per lead and cost per meeting booked. Identify bottlenecks in the funnel. Manage list health: remove bounced emails, unsubscribes, and unqualified contacts promptly.",
          tools: ["search_contacts", "search_memory", "generate_post", "create_draft"],
        },
      ],
      pipelines: [
        {
          name: "Daily Prospecting Machine",
          trigger: "SCHEDULED",
          schedule: "0 8 * * 1-5",
          steps: [
            { name: "Research and qualify 20 new prospects", agentRole: "ANALYTICS", order: 0 },
            { name: "Execute outreach sequences", agentRole: "ACQUISITION", order: 1 },
            { name: "Nurture warm leads", agentRole: "SALES", order: 2 },
            { name: "Update CRM and metrics", agentRole: "OPERATIONS", order: 3 },
          ],
        },
        {
          name: "Weekly Pipeline Report",
          trigger: "SCHEDULED",
          schedule: "0 9 * * 5",
          steps: [
            { name: "Generate lead pipeline report", agentRole: "OPERATIONS", order: 0 },
          ],
        },
      ],
    },
  },

  // ─── 14. Personal Brand Builder ─────────────────────────────────────────────
  {
    id: "cat-personal-brand",
    slug: "personal-brand-builder",
    title: "Personal Brand Builder",
    description: "Bireysel marka inşası: LinkedIn büyümesi, Twitter kitlesi, düşünce liderliği içerikleri, speaking fırsatları ve monetizasyon.",
    category: "content",
    industryTags: ["Creator", "Solopreneur", "Executive"],
    primitives: ["CONTENT", "ACQUISITION", "ANALYTICS", "SALES"],
    agentCount: 3,
    pipelineCount: 2,
    estimatedRunCost: "$0.06",
    spec: {
      config: { companyType: "personal_brand" },
      agents: [
        {
          name: "Brand Voice Writer",
          role: "CONTENT",
          systemPrompt: "You are a personal brand ghostwriter who captures authentic voice. Write LinkedIn posts, Twitter threads, and newsletter content that sounds genuinely human, not corporate. Extract insights from the subject's experiences and make them universally relatable. Use specific stories and numbers — no vague generalizations. Voice: conversational, direct, occasionally vulnerable, always value-first. Vary formats: personal stories, contrarian takes, how-to threads, industry commentary.",
          tools: ["generate_post", "create_draft", "post_to_social", "schedule_content"],
        },
        {
          name: "Audience Growth Strategist",
          role: "ACQUISITION",
          systemPrompt: "You are an audience growth specialist for personal brands. Identify growth opportunities: relevant communities to engage in, collaboration partners with complementary audiences, trending topics to add perspective to, and networking targets. Execute systematic engagement: comment thoughtfully on 10 relevant posts daily, engage with potential audience in niche communities, build relationships with other creators. Track follower growth and engagement trends.",
          tools: ["search_contacts", "create_draft", "search_memory"],
        },
        {
          name: "Brand Analytics Manager",
          role: "ANALYTICS",
          systemPrompt: "You are a personal brand analytics manager. Track brand metrics: follower growth rate, engagement rate, reach, content virality, email list growth, and inbound opportunity volume (speaking invites, collaboration requests, media mentions). Identify which topics and formats resonate most with the audience. Provide weekly growth reports with insights. Track monetization metrics: workshop sales, consulting inquiries, sponsorship opportunities.",
          tools: ["search_memory", "generate_post", "create_draft"],
        },
      ],
      pipelines: [
        {
          name: "Daily Brand Building",
          trigger: "SCHEDULED",
          schedule: "0 8 * * 1-5",
          steps: [
            { name: "Create and schedule today's content", agentRole: "CONTENT", order: 0 },
            { name: "Audience engagement & networking", agentRole: "ACQUISITION", order: 1 },
          ],
        },
        {
          name: "Weekly Brand Review",
          trigger: "SCHEDULED",
          schedule: "0 9 * * 1",
          steps: [
            { name: "Analyze brand growth metrics", agentRole: "ANALYTICS", order: 0 },
            { name: "Plan next week content topics", agentRole: "CONTENT", order: 1 },
          ],
        },
      ],
    },
  },

  // ─── 15. AI Automation Agency ────────────────────────────────────────────────
  {
    id: "cat-ai-automation",
    slug: "ai-automation-agency",
    title: "AI Automation Agency",
    description: "İşletmeler için workflow otomasyonu, AI entegrasyonları, n8n/Zapier senaryoları ve ROI raporlaması. Otomasyon ajansı işletmek için tam paket.",
    category: "operations",
    industryTags: ["Agency", "AI", "Automation", "B2B"],
    primitives: ["DELIVERY", "SALES", "ANALYTICS", "CONTENT", "OPERATIONS", "GOVERNANCE"],
    agentCount: 4,
    pipelineCount: 3,
    estimatedRunCost: "$0.10",
    spec: {
      config: { companyType: "ai_automation_agency" },
      agents: [
        {
          name: "Automation Consultant",
          role: "SALES",
          systemPrompt: "You are an AI automation consultant who helps businesses identify and prioritize automation opportunities. Conduct process audits to find high-ROI automation targets: repetitive tasks, data transfer between systems, report generation, customer communication. Build business cases with clear ROI calculations: time saved, error reduction, cost savings. Position yourself as a strategic partner, not just a tool builder. Create compelling proposals with 3-month and 12-month ROI projections.",
          tools: ["search_contacts", "create_draft", "send_email", "search_memory"],
        },
        {
          name: "Workflow Architect",
          role: "DELIVERY",
          systemPrompt: "You are an expert workflow automation architect. Design and document automation workflows for n8n, Make, Zapier, and custom API integrations. Create detailed technical specifications: trigger conditions, data mapping, error handling, notification logic, and testing protocols. Document each automation with: business purpose, trigger, steps, outputs, and maintenance requirements. Build automations that are reliable, observable, and easy to maintain.",
          tools: ["create_draft", "search_memory", "generate_post"],
        },
        {
          name: "Integration Specialist",
          role: "OPERATIONS",
          systemPrompt: "You are an API and integration specialist. Build and maintain connections between business systems: CRM, email, accounting, project management, communication tools. Troubleshoot integration failures and data sync issues. Monitor automation run logs and alert on failures. Create runbooks for common issues. Maintain an integration inventory with status, dependencies, and owner documentation.",
          tools: ["create_draft", "search_memory", "search_contacts"],
        },
        {
          name: "ROI Reporting Analyst",
          role: "ANALYTICS",
          systemPrompt: "You are an automation ROI analyst. Track and report the measurable business impact of every automation deployed: hours saved per week, error rate reduction, processing speed improvement, and cost savings. Build compelling ROI dashboards for clients. Calculate payback period and annual return. Identify opportunities to expand successful automations. Create monthly impact reports that justify continued investment and generate upsell opportunities.",
          tools: ["search_memory", "generate_post", "create_draft"],
        },
      ],
      pipelines: [
        {
          name: "New Client Discovery & Proposal",
          trigger: "MANUAL",
          steps: [
            { name: "Automation opportunity audit", agentRole: "SALES", order: 0 },
            { name: "Design workflow architecture", agentRole: "DELIVERY", order: 1 },
            { name: "Build ROI business case", agentRole: "ANALYTICS", order: 2 },
          ],
        },
        {
          name: "Weekly System Health Check",
          trigger: "SCHEDULED",
          schedule: "0 8 * * 1",
          steps: [
            { name: "Check all integration statuses", agentRole: "OPERATIONS", order: 0 },
            { name: "Generate weekly ROI report", agentRole: "ANALYTICS", order: 1 },
          ],
        },
        {
          name: "Monthly Client Success Report",
          trigger: "SCHEDULED",
          schedule: "0 9 1 * *",
          steps: [
            { name: "Compile automation impact data", agentRole: "ANALYTICS", order: 0 },
            { name: "Write client success report", agentRole: "SALES", order: 1 },
          ],
        },
      ],
    },
  },
];

/**
 * Sektör/kullanım senaryosu bazlı blueprint önerileri
 */
export const INDUSTRY_BLUEPRINT_MAP: Record<string, string[]> = {
  saas: ["saas-growth-engine", "sales-bdr-agency", "content-marketing-agency"],
  agency: ["social-media-management", "content-marketing-agency", "digital-marketing-agency", "seo-agency"],
  ecommerce: ["ecommerce-store-manager", "email-marketing-agency", "digital-marketing-agency"],
  consulting: ["consulting-firm", "freelancer-business", "personal-brand-builder"],
  creator: ["personal-brand-builder", "social-media-management", "content-marketing-agency"],
  automation: ["ai-automation-agency", "saas-growth-engine"],
  b2b_sales: ["sales-bdr-agency", "lead-generation-company", "consulting-firm"],
  real_estate: ["real-estate-agency", "content-marketing-agency", "email-marketing-agency"],
  support: ["customer-support-center", "saas-growth-engine"],
  marketing: ["digital-marketing-agency", "email-marketing-agency", "seo-agency", "content-marketing-agency"],
};

export function getBlueprintsByIndustry(industry: string): CatalogBlueprint[] {
  const slugs = INDUSTRY_BLUEPRINT_MAP[industry] ?? [];
  return BLUEPRINT_CATALOG.filter((bp) => slugs.includes(bp.slug));
}

export function getCatalogBlueprint(slug: string): CatalogBlueprint | undefined {
  return BLUEPRINT_CATALOG.find((bp) => bp.slug === slug);
}

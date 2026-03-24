import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  // Create default tenant
  const tenant = await prisma.tenant.upsert({
    where: { slug: "default" },
    update: {},
    create: {
      name: "Default Workspace",
      slug: "default",
      plan: "FREE",
    },
  });

  // Create admin user
  const user = await prisma.user.upsert({
    where: { email: "admin@aicompanyos.local" },
    update: {},
    create: {
      tenantId: tenant.id,
      email: "admin@aicompanyos.local",
      name: "Admin",
      role: "OWNER",
    },
  });

  // Create hero company: Social Media Management
  const company = await prisma.company.upsert({
    where: { tenantId_slug: { tenantId: tenant.id, slug: "hero-social-media" } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: "Hero Social Media Agency",
      slug: "hero-social-media",
      description: "Autonomous social media management + content studio",
      primitives: ["CONTENT", "ACQUISITION", "ANALYTICS", "DELIVERY"],
      status: "ACTIVE",
      config: {
        channels: ["tiktok", "linkedin"],
        contentTypes: ["social_post", "video_script"],
        postingFrequency: "daily",
      },
    },
  });

  // Create content agent
  await prisma.agent.upsert({
    where: { id: "agent-content-creator" },
    update: {},
    create: {
      id: "agent-content-creator",
      companyId: company.id,
      name: "Content Creator",
      role: "content_creator",
      systemPrompt:
        "You are an autonomous content creator agent. You create engaging social media content for TikTok and LinkedIn. Always explain your creative decisions.",
      tools: [
        "generate_post",
        "analyze_trends",
        "schedule_content",
        "create_draft",
      ],
    },
  });

  // Create analytics agent
  await prisma.agent.upsert({
    where: { id: "agent-analytics" },
    update: {},
    create: {
      id: "agent-analytics",
      companyId: company.id,
      name: "Analytics Agent",
      role: "analytics",
      systemPrompt:
        "You are an analytics agent. You track content performance, identify trends, and provide insights to improve content strategy.",
      tools: ["fetch_metrics", "generate_report", "compare_performance"],
    },
  });

  // Create a sample pipeline
  await prisma.pipeline.upsert({
    where: { id: "pipeline-daily-content" },
    update: {},
    create: {
      id: "pipeline-daily-content",
      companyId: company.id,
      name: "Daily Content Pipeline",
      description: "Generate and publish daily social media content",
      trigger: "SCHEDULED",
      schedule: "0 9 * * *", // Every day at 9 AM
      steps: [
        { name: "analyze_trends", agentRole: "analytics", order: 1 },
        { name: "create_content", agentRole: "content_creator", order: 2 },
        { name: "review_draft", agentRole: "content_creator", order: 3 },
        { name: "publish", agentRole: "content_creator", order: 4 },
      ],
    },
  });

  // Log the seed activity
  await prisma.activityLog.create({
    data: {
      tenantId: tenant.id,
      actor: "system",
      action: "seed.complete",
      resource: "database",
      details: {
        tenant: tenant.slug,
        user: user.email,
        company: company.slug,
      },
    },
  });

  console.log("Seed complete:");
  console.log(`  Tenant: ${tenant.slug}`);
  console.log(`  User: ${user.email}`);
  console.log(`  Company: ${company.slug}`);
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

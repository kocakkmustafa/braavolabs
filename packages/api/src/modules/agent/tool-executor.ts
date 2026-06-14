/**
 * Tool Executor — executes tool calls with approval gates,
 * rate limiting, tenant isolation, and audit logging.
 */

import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import {
  getTool,
  getToolMeta,
  isMoneyTouching,
  requiresApprovalForAutonomy,
  type ToolMeta,
  type AgentAutonomyLevel,
} from "./registry";
import { notifyTenantUsers } from "../../services/push";
import { publishRunEvent } from "../../lib/runEvents";

export interface ToolExecResult {
  output: unknown;
  status: "COMPLETED" | "FAILED" | "PENDING_APPROVAL";
  durationMs: number;
  error?: string;
  approvalId?: string;
}

/**
 * If the tool input references a companyId (by ID, name or slug), validate
 * it belongs to the tenant. Returns the canonical company row or null if
 * no companyId was supplied. Throws if a companyId was supplied but does
 * NOT belong to this tenant (cross-tenant leak attempt).
 */
async function enforceTenantScopedCompany(
  input: unknown,
  tenantId: string,
): Promise<{ id: string; tenantId: string } | null> {
  if (!input || typeof input !== "object") return null;
  const raw = (input as any).companyId;
  if (!raw || typeof raw !== "string") return null;

  // Accept ID, name, or slug — but ALL must scope to this tenant.
  const candidate = await prisma.company.findFirst({
    where: {
      tenantId,
      OR: [{ id: raw }, { name: raw }, { slug: raw }],
    },
    select: { id: true, tenantId: true },
  });

  if (!candidate) {
    throw new Error(
      `Tenant isolation violation: companyId "${raw}" does not belong to tenant "${tenantId}"`,
    );
  }
  return candidate;
}

/**
 * CRIT-3 defense: tool inputs that reference second-class IDs (contactId,
 * dealId, sequenceId, draftId) bypassed enforceTenantScopedCompany — the
 * latter only validates `companyId`. An attacker controlling agent input
 * via prompt-injection (memory poisoning, malicious blueprint clone) could
 * call e.g. crm_update_deal_stage with another tenant's dealId, and the
 * Prisma update would go through.
 *
 * This function checks every well-known ID field present in the input and
 * verifies it traces back to a company owned by this tenant. Throws on
 * any mismatch. Unknown ID-shaped fields are ignored — we only block IDs
 * we know map to tenant-isolated tables.
 */
async function enforceTenantScopedSecondaryIds(
  input: unknown,
  tenantId: string,
): Promise<void> {
  if (!input || typeof input !== "object") return;
  const obj = input as Record<string, unknown>;

  // contactId → contact → company.tenantId
  if (typeof obj.contactId === "string" && obj.contactId.length > 0) {
    const ok = await prisma.contact.findFirst({
      where: { id: obj.contactId, company: { tenantId } },
      select: { id: true },
    });
    if (!ok) {
      throw new Error(
        `Tenant isolation violation: contactId "${obj.contactId}" does not belong to tenant "${tenantId}"`,
      );
    }
  }

  // dealId → deal → company.tenantId
  if (typeof obj.dealId === "string" && obj.dealId.length > 0) {
    const ok = await prisma.deal.findFirst({
      where: { id: obj.dealId, company: { tenantId } },
      select: { id: true },
    });
    if (!ok) {
      throw new Error(
        `Tenant isolation violation: dealId "${obj.dealId}" does not belong to tenant "${tenantId}"`,
      );
    }
  }

  // sequenceId → outreachSequence → company.tenantId
  if (typeof obj.sequenceId === "string" && obj.sequenceId.length > 0) {
    const ok = await prisma.outreachSequence.findFirst({
      where: { id: obj.sequenceId, company: { tenantId } },
      select: { id: true },
    });
    if (!ok) {
      throw new Error(
        `Tenant isolation violation: sequenceId "${obj.sequenceId}" does not belong to tenant "${tenantId}"`,
      );
    }
  }

  // draftId → draft → company.tenantId
  if (typeof obj.draftId === "string" && obj.draftId.length > 0) {
    const ok = await prisma.draft.findFirst({
      where: { id: obj.draftId, company: { tenantId } },
      select: { id: true },
    });
    if (!ok) {
      throw new Error(
        `Tenant isolation violation: draftId "${obj.draftId}" does not belong to tenant "${tenantId}"`,
      );
    }
  }
}

/**
 * Execute a tool call with governance checks.
 */
export async function executeTool(
  toolName: string,
  input: unknown,
  context: {
    runId?: string;
    runStepId?: string;
    companyId: string;
    tenantId: string;
    /**
     * Graduated autonomy (Feature D6) of the acting agent. Decides whether
     * NON-money tool calls pause for approval. Defaults to BALANCED — the
     * historical behaviour — when the caller omits it (bare invocations).
     */
    autonomy?: AgentAutonomyLevel;
  },
): Promise<ToolExecResult> {
  const start = Date.now();
  const tool = getTool(toolName);
  const meta = getToolMeta(toolName);

  if (!tool) {
    return {
      output: null,
      status: "FAILED",
      durationMs: Date.now() - start,
      error: `Tool "${toolName}" not found in registry`,
    };
  }

  // --- Tenant isolation: if input carries a companyId, it MUST belong to
  //     this tenant. Rewrite input with canonical company id so downstream
  //     handlers can't be fooled by name/slug collisions across tenants.
  //     Also validate any second-class IDs (contactId, dealId, sequenceId,
  //     draftId) — see CRIT-3 in the security audit.
  let scopedInput = input;
  try {
    const scoped = await enforceTenantScopedCompany(input, context.tenantId);
    if (scoped && input && typeof input === "object") {
      scopedInput = { ...(input as Record<string, unknown>), companyId: scoped.id };
    }
    // Cross-ID tenant scoping. Any tool input field that names a row in a
    // tenant-isolated table must trace back to this tenant. Otherwise an
    // agent prompt-injection can mutate a victim tenant's CRM/draft/seq.
    await enforceTenantScopedSecondaryIds(scopedInput, context.tenantId);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ toolName, tenantId: context.tenantId, error }, "Tool tenant isolation blocked");
    return {
      output: null,
      status: "FAILED",
      durationMs: Date.now() - start,
      error: "Access denied: referenced record is not in your workspace",
    };
  }

  // --- Human-in-the-loop interrupt gate (ask_user) ---
  // The agent is asking the operator a question. Mirror the spend gate:
  // create an INPUT approval, drive the run to WAITING_APPROVAL, push, and
  // return PENDING_APPROVAL so the runner exits cleanly. The operator's
  // answer (POST /approvals/:id/decide with a note) becomes a
  // SteeringMessage(INPUT) the agent loop injects on resume.
  if (meta?.interrupt === "INPUT") {
    if (!context.runId) {
      return {
        output: null,
        status: "FAILED",
        durationMs: Date.now() - start,
        error: `Tool "${toolName}" requires a run context`,
      };
    }
    const question =
      typeof (scopedInput as any)?.question === "string"
        ? (scopedInput as any).question
        : "The agent requested input.";

    const approval = await prisma.approval.create({
      data: {
        runId: context.runId,
        type: "INPUT",
        description: question.slice(0, 2000),
        metadata: { toolName, question } as any,
        status: "PENDING",
      },
    });

    await prisma.run.update({
      where: { id: context.runId },
      data: { status: "WAITING_APPROVAL" },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: context.tenantId,
        actor: "system",
        action: "input.requested",
        resource: "run",
        resourceId: context.runId,
        details: { approvalId: approval.id, question: question.slice(0, 500) } as any,
      },
    });

    await publishRunEvent(context.runId, {
      type: "INPUT_REQUESTED",
      interruptId: approval.id,
      stepId: context.runStepId,
      question: question.slice(0, 500),
    });

    // Route the tap to the run detail (where the answer form lives), not the
    // approvals tab — but keep the "approval" category so it respects the
    // default-ON approvals notification preference.
    notifyTenantUsers(context.tenantId, "approval", {
      title: "Agent needs your input",
      body: question.slice(0, 120),
      data: { kind: "run", id: context.runId },
    }).catch(() => {});

    logger.info({ toolName, approvalId: approval.id }, "Agent asked for human input — paused");
    return {
      output: null,
      status: "PENDING_APPROVAL",
      durationMs: Date.now() - start,
      approvalId: approval.id,
    };
  }

  // --- Approval gate (graduated autonomy, Feature D6) ---
  // CLAUDE.md rule #3: any money-touching action ALWAYS passes through the
  // approvals table — inviolable, regardless of autonomy. For non-money tools
  // the acting agent's autonomy level decides whether to pause:
  //   SUPERVISED → pause on every side-effecting tool
  //   BALANCED   → pause on spend + risky tools (historical default)
  //   AUTONOMOUS → never pause for routine tools (only money + risk-stops gate)
  // BALANCED is the safe default when no autonomy is threaded (bare calls).
  const autonomy: AgentAutonomyLevel = context.autonomy ?? "BALANCED";
  if (requiresApprovalForAutonomy(meta, autonomy)) {
    if (!context.runId) {
      logger.error({ toolName }, "Approval required but no runId in context — blocking");
      return {
        output: null,
        status: "FAILED",
        durationMs: Date.now() - start,
        error: `Tool "${toolName}" requires approval but executor has no run context`,
      };
    }
    // Surface the cost field on Approval.amountUsd so the human approver
    // sees the figure they're greenlighting in the standard list view —
    // burying it in metadata.input.budgetUsd meant operators routinely
    // approved without seeing the dollar amount. Each approval-requiring
    // tool declares its cost field via meta.costField (defaults to
    // "budgetUsd" for the historical ad_spend contract).
    const costField = (meta as any)?.costField ?? "budgetUsd";
    const rawAmount = (scopedInput as any)?.[costField];
    const amountUsd =
      typeof rawAmount === "number" && Number.isFinite(rawAmount) && rawAmount >= 0
        ? rawAmount
        : null;

    // Honest description: money approvals say "spend"; autonomy-driven pauses on
    // non-money tools say "action" so the operator isn't misled into reading a
    // $0 spend. amountUsd stays null for non-money pauses (the UI hides it).
    const money = isMoneyTouching(meta);
    const description = money
      ? `Approval required for tool: ${toolName}`
      : `Action needs your approval: ${toolName}`;

    const approval = await prisma.approval.create({
      data: {
        runId: context.runId,
        type: "SPEND",
        description,
        amountUsd: amountUsd as any,
        metadata: { toolName, input: scopedInput, costField, moneyTouching: money, autonomy } as any,
        status: "PENDING",
      },
    });

    // Drive the run into WAITING_APPROVAL so the next step-group iteration
    // in the runner sees a non-RUNNING status and exits cleanly. Without
    // this the BullMQ job kept iterating and the run completed normally
    // while the approval row sat orphaned at PENDING — see ISS-022.
    await prisma.run.update({
      where: { id: context.runId },
      data: { status: "WAITING_APPROVAL" },
    });

    await prisma.activityLog.create({
      data: {
        tenantId: context.tenantId,
        actor: "system",
        action: "approval.requested",
        resource: "tool_call",
        details: { toolName, approvalId: approval.id, amountUsd } as any,
      },
    });

    // Fire push notifications to every device in the tenant whose user
    // has the `approvals` pref enabled (default ON). Fire-and-forget —
    // we never want a push hiccup to block the executor.
    notifyTenantUsers(context.tenantId, "approval", {
      title: "Approval needed",
      body: `Tool ${toolName} is waiting for your decision`,
      data: { kind: "approval", id: approval.id, toolName },
    }).catch(() => {});

    logger.info({ toolName, approvalId: approval.id }, "Tool requires approval — paused");
    return {
      output: null,
      status: "PENDING_APPROVAL",
      durationMs: Date.now() - start,
      approvalId: approval.id,
    };
  }

  // --- Rate limit check ---
  if (meta?.rateLimit) {
    const oneMinuteAgo = new Date(Date.now() - 60_000);
    const recentCalls = await prisma.toolCall.count({
      where: {
        toolName,
        runStep: { run: { pipeline: { companyId: context.companyId } } },
        createdAt: { gte: oneMinuteAgo },
      },
    });
    if (recentCalls >= meta.rateLimit) {
      return {
        output: null,
        status: "FAILED",
        durationMs: Date.now() - start,
        error: `Rate limit exceeded: ${recentCalls}/${meta.rateLimit} calls/min for "${toolName}"`,
      };
    }
  }

  // --- Execute with tenant-scoped input ---
  try {
    const output = await tool.handler(scopedInput);
    const durationMs = Date.now() - start;

    // Log tool call
    if (context.runStepId) {
      await prisma.toolCall.create({
        data: {
          runStepId: context.runStepId,
          toolName,
          input: scopedInput as any,
          output: output as any,
          status: "COMPLETED",
          durationMs,
        },
      });
    }

    return { output, status: "COMPLETED", durationMs };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - start;

    if (context.runStepId) {
      await prisma.toolCall.create({
        data: {
          runStepId: context.runStepId,
          toolName,
          input: scopedInput as any,
          output: {} as any,
          status: "FAILED",
          durationMs,
          error,
        },
      });
    }

    logger.error({ toolName, error }, "Tool execution failed");
    return { output: null, status: "FAILED", durationMs, error };
  }
}

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
  type ToolDefinition,
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
 * CRIT-3 / FINDINGS H2 defense: tool inputs that reference tenant-isolated
 * rows by ID bypassed enforceTenantScopedCompany — the latter only validates
 * `companyId`. An attacker controlling agent input via prompt-injection
 * (memory poisoning, malicious blueprint clone) could call e.g.
 * crm_update_deal_stage with another tenant's dealId and the Prisma update
 * would go through.
 *
 * Each entry maps a tool-input field to a predicate that returns true iff
 * that ID traces back to the acting tenant. To keep this exhaustive (the
 * previous version silently ignored any field outside a hard-coded list, so
 * a NEW tool taking e.g. `voiceAgentId` would be unprotected), the executor
 * also FAILS CLOSED on any unrecognised `*Id` input field — see
 * `enforceTenantScopedSecondaryIds`.
 */
const SECONDARY_ID_VALIDATORS: Record<
  string,
  (id: string, tenantId: string) => Promise<boolean>
> = {
  contactId: async (id, tenantId) =>
    !!(await prisma.contact.findFirst({ where: { id, company: { tenantId } }, select: { id: true } })),
  dealId: async (id, tenantId) =>
    !!(await prisma.deal.findFirst({ where: { id, company: { tenantId } }, select: { id: true } })),
  sequenceId: async (id, tenantId) =>
    !!(await prisma.outreachSequence.findFirst({ where: { id, company: { tenantId } }, select: { id: true } })),
  draftId: async (id, tenantId) =>
    !!(await prisma.draft.findFirst({ where: { id, company: { tenantId } }, select: { id: true } })),
  // VoiceAgent → companyId → company.tenantId. make_outbound_call takes a
  // voiceAgentId; it is money-touching (approval-gated) and placeOutboundCall
  // re-scopes, but validating here makes the executor the single chokepoint.
  voiceAgentId: async (id, tenantId) =>
    !!(await prisma.voiceAgent.findFirst({ where: { id, company: { tenantId } }, select: { id: true } })),
  // external_control acts on a tenant's connected automation — the connection
  // must belong to the acting tenant (ExternalConnection is tenant-scoped
  // directly, not via company).
  connectionId: async (id, tenantId) =>
    !!(await prisma.externalConnection.findFirst({ where: { id, tenantId }, select: { id: true } })),
};

// `*Id`-shaped input fields that are NOT references to tenant-isolated rows
// and so must NOT trip the fail-closed guard:
//   - companyId  → validated by enforceTenantScopedCompany (runs first)
//   - voiceId    → external ElevenLabs voice identifier, not a DB row
//   - tenantId   → if present in input it is ignored; context.tenantId wins
//   - targetId   → external_control: a platform workflow/scenario id or a
//                  webhook URL, NOT a Braavolabs row (the connectionId it acts
//                  through is what's tenant-validated above)
const SAFE_INPUT_ID_FIELDS = new Set(["companyId", "voiceId", "tenantId", "targetId"]);

export async function enforceTenantScopedSecondaryIds(
  input: unknown,
  tenantId: string,
  toolName: string,
): Promise<void> {
  if (!input || typeof input !== "object") return;
  const obj = input as Record<string, unknown>;

  for (const [key, value] of Object.entries(obj)) {
    // Only consider camelCase `…Id` fields (companyId, voiceAgentId) — not
    // "id", "uuid", "valid", etc.
    if (!/[a-z]Id$/.test(key)) continue;
    if (SAFE_INPUT_ID_FIELDS.has(key)) continue;

    const validator = SECONDARY_ID_VALIDATORS[key];
    if (!validator) {
      // FAIL CLOSED: an unrecognised id-shaped field reached a tool input.
      // Rather than silently letting it flow into a handler's `where` clause
      // (the old behaviour), refuse it. Adding a new tool with a new id field
      // now forces a deliberate choice — add a validator or mark it safe.
      throw new Error(
        `Unrecognised tenant-scoped id field "${key}" on tool "${toolName}" — refusing for tenant safety`,
      );
    }
    if (typeof value !== "string" || value.length === 0) continue;
    if (!(await validator(value, tenantId))) {
      throw new Error(
        `Tenant isolation violation: ${key} "${value}" does not belong to tenant "${tenantId}"`,
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
    /**
     * D-005 (E5/T7): request-scoped dynamic connector tools. These come from
     * the acting tenant's installed connectors and are NEVER written to the
     * global tool registry — that would leak tenant-A's tools into tenant-B's
     * agent loop. The executor resolves the definition + its DERIVED meta
     * (deriveConnectorToolMeta) from this map FIRST, then falls back to the
     * global registry, so a connector tool's approval/money gate is honoured
     * exactly like a static tool's.
     */
    extraTools?: Map<string, ToolDefinition>;
  },
): Promise<ToolExecResult> {
  const start = Date.now();
  // Request-scoped connector tools take precedence over the global registry.
  // They are per-tenant and MUST NOT be resolvable by any other request.
  const dynamicTool = context.extraTools?.get(toolName);
  const tool = dynamicTool ?? getTool(toolName);
  const meta = dynamicTool ? dynamicTool.meta : getToolMeta(toolName);

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
    // Fails closed on unrecognised `*Id` fields (FINDINGS H2).
    await enforceTenantScopedSecondaryIds(scopedInput, context.tenantId, toolName);
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

  // --- External-automation control gate (the #4 moat) ---
  // The agent wants to act on a CONNECTED automation. Never execute inline:
  // open an EXTERNAL_CONTROL approval carrying the intent, pause the run, and
  // let a human approve (dashboard or phone — the same queue the app renders).
  // The decide handler runs the real action and resumes the agent with the
  // result as a SteeringMessage. Intercepts BEFORE the spend gate.
  if (meta?.externalControl) {
    if (!context.runId) {
      return {
        output: null,
        status: "FAILED",
        durationMs: Date.now() - start,
        error: `Tool "${toolName}" requires a run context`,
      };
    }
    const ci = (scopedInput ?? {}) as Record<string, unknown>;
    const connectionId = typeof ci.connectionId === "string" ? ci.connectionId : "";
    const action = typeof ci.action === "string" ? ci.action.toUpperCase() : "";
    const targetId = typeof ci.targetId === "string" ? ci.targetId : "";
    if (!connectionId || !["TRIGGER", "PAUSE", "RESUME"].includes(action) || !targetId) {
      return {
        output: null,
        status: "FAILED",
        durationMs: Date.now() - start,
        error: "external_control needs connectionId, action (TRIGGER|PAUSE|RESUME) and targetId",
      };
    }
    // connectionId was already tenant-validated by the secondary-id guard; load
    // platform + label for a human-readable approval card.
    const conn = await prisma.externalConnection.findFirst({
      where: { id: connectionId, tenantId: context.tenantId },
      select: { platform: true, label: true },
    });
    if (!conn) {
      return {
        output: null,
        status: "FAILED",
        durationMs: Date.now() - start,
        error: "Connection not found in your workspace",
      };
    }
    const description = `${action} ${conn.platform} automation "${conn.label}"`;
    const approval = await prisma.approval.create({
      data: {
        runId: context.runId,
        type: "EXTERNAL_CONTROL",
        description: description.slice(0, 2000),
        metadata: { toolName, connectionId, action, targetId } as any,
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
        action: "external_control.requested",
        resource: "approval",
        resourceId: approval.id,
        details: { connectionId, action, targetId, platform: conn.platform } as any,
      },
    });

    await publishRunEvent(context.runId, {
      type: "INPUT_REQUESTED",
      interruptId: approval.id,
      stepId: context.runStepId,
      question: description.slice(0, 500),
    });

    notifyTenantUsers(context.tenantId, "approval", {
      title: "Automation control needs approval",
      body: description.slice(0, 120),
      data: { kind: "approval", id: approval.id, toolName },
    }).catch(() => {});

    logger.info(
      { toolName, approvalId: approval.id, action },
      "Agent requested external control — paused for approval",
    );
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

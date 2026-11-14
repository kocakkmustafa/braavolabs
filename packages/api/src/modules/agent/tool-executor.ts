/**
 * Tool Executor — executes tool calls with approval gates,
 * rate limiting, tenant isolation, and audit logging.
 */

import { prisma } from "../../lib/db";
import { transitionRun } from "../run/transition";
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
import { disabledFeatureForTool, outboundFeatureDisabledError } from "../../lib/outbound-gates";
import {
  buildApprovalStamp,
  computeActionHash,
  consumeGrant,
  isExactActionApprovalEnabled,
  type ApprovalStamp,
  type ExactAction,
} from "../approval/exact-action";

export interface ToolExecResult {
  output: unknown;
  status: "COMPLETED" | "FAILED" | "PENDING_APPROVAL";
  durationMs: number;
  error?: string;
  approvalId?: string;
}

/**
 * SEC-BRA-06 shared guards (governed executor AND the ungoverned loops in
 * claude.ts / claude-local.ts — one definition, no copies).
 * `toolTakesCompanyId`: the tool's input schema declares a companyId.
 * `inputHasCompanyId`: the call carries a companyId key (any type); safe for
 * non-object input (string/null/array never throws).
 */
export function toolTakesCompanyId(tool: Pick<ToolDefinition, "inputSchema"> | undefined): boolean {
  const props = (tool?.inputSchema as { properties?: unknown } | undefined)?.properties;
  return !!props && typeof props === "object" && Object.prototype.hasOwnProperty.call(props, "companyId");
}

export function inputHasCompanyId(input: unknown): boolean {
  return (
    !!input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    (input as Record<string, unknown>).companyId !== undefined
  );
}

/**
 * Ungoverned callers have NO acting company to inject or compare against, so a
 * tool that takes a companyId (by schema or by input) must not run there.
 */
export function requiresGovernedTenantScope(
  tool: Pick<ToolDefinition, "inputSchema"> | undefined,
  input: unknown,
): boolean {
  return toolTakesCompanyId(tool) || inputHasCompanyId(input);
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
  // delegate (hierarchical manager) names a worker Agent; Agent → company → tenant.
  agentId: async (id, tenantId) =>
    !!(await prisma.agent.findFirst({ where: { id, company: { tenantId } }, select: { id: true } })),
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
    if (value === undefined || value === null) continue;
    // Non-string (object/array/number — e.g. a Prisma operator object) must
    // never reach a handler's `where`.
    if (typeof value !== "string") {
      throw new Error(`Tenant isolation violation: ${key} must be a string`);
    }
    if (value.length === 0) continue;
    if (!(await validator(value, tenantId))) {
      throw new Error(
        `Tenant isolation violation: ${key} "${value}" does not belong to tenant "${tenantId}"`,
      );
    }
  }
}

/** Overwrite any model-supplied tenantId with the acting tenant (meta.injectTenantId tools). */
export function withActingTenant(input: unknown, tenantId: string): Record<string, unknown> {
  const obj = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  return { ...obj, tenantId };
}

function isTenantRowIdKey(key: string): boolean {
  return /[a-z]Id$/.test(key) && !SAFE_INPUT_ID_FIELDS.has(key);
}

/**
 * SEC-BRA-06c: shared fail-closed guard for the UNGOVERNED paths (claude.ts
 * ungoverned branch, claude-local.ts). Returns an error string, or null when
 * the call may run.
 *  - companyId tools never run ungoverned (no acting company to compare).
 *  - tools that name tenant rows by a secondary `*Id` (dealId, contactId, ...)
 *    run ONLY when the caller knows the acting tenant; every id in the input
 *    is then validated with the same logic as the governed path
 *    (enforceTenantScopedSecondaryIds, fails closed on unknown `*Id`).
 *    Without a tenantId (local CLI mode) they are refused.
 *  - tools without any tenant-scoped field (ask_user, delegate, generate_post)
 *    are untouched.
 */
export async function guardUngovernedTenantScope(
  tool: Pick<ToolDefinition, "inputSchema"> | undefined,
  input: unknown,
  toolName: string,
  tenantId?: string,
): Promise<string | null> {
  if (requiresGovernedTenantScope(tool, input)) {
    return `Tool "${toolName}" requires a tenant-scoped pipeline run (companyId in input)`;
  }
  const props = (tool?.inputSchema as { properties?: unknown } | undefined)?.properties;
  const schemaKeys = props && typeof props === "object" ? Object.keys(props) : [];
  const inputKeys =
    input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input as object) : [];
  const touchesTenantRows = [...schemaKeys, ...inputKeys].some(isTenantRowIdKey);
  if (!touchesTenantRows) return null;
  if (!tenantId) {
    return `Tool "${toolName}" requires a tenant-scoped pipeline run (tenant-scoped id in input)`;
  }
  try {
    await enforceTenantScopedSecondaryIds(input, tenantId, toolName);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

/**
 * BRA-P0-02c-3: drive the run into WAITING_APPROVAL through `transitionRun`
 * (graph state NEEDS_APPROVAL). Called right AFTER the gate's approval row is
 * created; if the transition cannot happen (CAS lost to a concurrent /stop or
 * /pause, or — with JOB_STATE_DUAL_WRITE on — an illegal edge such as a
 * finished run) the just-created approval is removed again so a lost race
 * leaves no orphaned PENDING approval, and the caller returns a FAILED tool
 * result without any push / event / activity row.
 */
async function enterWaitingApproval(runId: string, tenantId: string, approvalId: string): Promise<boolean> {
  const o = await transitionRun(prisma, runId, "NEEDS_APPROVAL", { tenantId, legacyUnchecked: true });
  if (o.ok) return true;
  logger.warn({ runId, approvalId, reason: o.reason }, "Approval gate: run could not enter WAITING_APPROVAL — approval withdrawn");
  await prisma.approval
    .deleteMany({ where: { id: approvalId, status: "PENDING" } })
    .catch((err) => logger.warn({ approvalId, err: (err as Error).message }, "Approval gate: withdrawing approval failed"));
  return false;
}

function gateTransitionFailed(start: number): ToolExecResult {
  return {
    output: null,
    status: "FAILED",
    durationMs: Date.now() - start,
    error: "Run is no longer active; approval was not requested",
  };
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

  // B-06: outbound-contact tools (outreach enrollment, voice dialing) are
  // refused while their feature flag is off — before any approval row is
  // created, so nothing approvable reaches the approvals queue.
  // BRA-P1-03c: this single choke point also refuses deploy / merge style
  // tools (static or connector) until the founder-approved flag is on.
  const disabledFeature = disabledFeatureForTool(toolName, {
    dynamic: Boolean(dynamicTool),
    description: dynamicTool?.description,
  });
  if (disabledFeature) {
    const disabled = outboundFeatureDisabledError(disabledFeature);
    return {
      output: null,
      status: "FAILED",
      durationMs: Date.now() - start,
      error: `${disabled.code}: ${disabled.message}`,
    };
  }

  // --- Tenant isolation: if input carries a companyId, it MUST belong to
  //     this tenant. Rewrite input with canonical company id so downstream
  //     handlers can't be fooled by name/slug collisions across tenants.
  //     Also validate any second-class IDs (contactId, dealId, sequenceId,
  //     draftId) — see CRIT-3 in the security audit.
  let scopedInput = input;
  try {
    // SEC-BRA-06: a static tool that takes a companyId must run against the
    // ACTING company only. The model's value is never trusted: absent →
    // injected; non-string (object/array/null — Prisma operator objects) or a
    // different company → refused. Connector tools are excluded: their args
    // belong to the remote server, not to our Prisma queries.
    const takesCompanyId = !dynamicTool && toolTakesCompanyId(tool);
    const inputObj = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
    const hasCompanyKey = inputHasCompanyId(input);
    if (!dynamicTool && (takesCompanyId || hasCompanyKey)) {
      if (hasCompanyKey) {
        const v = inputObj?.companyId;
        // non-string (object/array/null) or empty/blank: never reaches a Prisma where
        if (typeof v !== "string" || v.trim() === "") {
          throw new Error("Tenant isolation violation: companyId is invalid");
        }
      } else if (takesCompanyId) {
        scopedInput = { ...(inputObj ?? {}), companyId: context.companyId };
      }
    }
    const scoped = await enforceTenantScopedCompany(scopedInput, context.tenantId);
    if (scoped && !dynamicTool && scoped.id !== context.companyId) {
      throw new Error("Tenant isolation violation: companyId is not the acting company");
    }
    if (scoped && scopedInput && typeof scopedInput === "object") {
      scopedInput = { ...(scopedInput as Record<string, unknown>), companyId: scoped.id };
    }
    // Cross-ID tenant scoping. Any tool input field that names a row in a
    // tenant-isolated table must trace back to this tenant. Otherwise an
    // agent prompt-injection can mutate a victim tenant's CRM/draft/seq.
    // Fails closed on unrecognised `*Id` fields (FINDINGS H2).
    await enforceTenantScopedSecondaryIds(scopedInput, context.tenantId, toolName);
    if (!dynamicTool && tool.meta?.injectTenantId) scopedInput = withActingTenant(scopedInput, context.tenantId);
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
        // SEC-BRA-05: owner written directly (not only via exact-action stamp).
        tenantId: context.tenantId,
        type: "INPUT",
        description: question.slice(0, 2000),
        metadata: { toolName, question } as any,
        status: "PENDING",
      },
    });

    if (!(await enterWaitingApproval(context.runId, context.tenantId, approval.id))) {
      return gateTransitionFailed(start);
    }

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
      localized: { title: "push.agentInputTitle" },
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
        tenantId: context.tenantId, // SEC-BRA-05
        type: "EXTERNAL_CONTROL",
        description: description.slice(0, 2000),
        // BRA-UX-API-01c: riskLevel registry meta'sından; TRIGGER geri alınamaz, PAUSE/RESUME birbirinin tersi.
        metadata: { toolName, connectionId, action, targetId, riskLevel: meta.riskLevel, reversible: action !== "TRIGGER" } as any,
        status: "PENDING",
      },
    });

    if (!(await enterWaitingApproval(context.runId, context.tenantId, approval.id))) {
      return gateTransitionFailed(start);
    }

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
      localized: { title: "push.automationApprovalTitle" },
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

    // Exact-action approval (BRA-P0-05, ADR-0002; EXACT_ACTION_APPROVAL, default
    // OFF). When on, an APPROVED approval is a single-use grant bound to this
    // tenant + run + the canonical action (tool, input, amount): the call runs
    // only if it can atomically spend such a grant, otherwise a new PENDING
    // approval is stamped with nonce + action hash + expiry. A changed input
    // hashes differently, so an old approval cannot authorise it.
    let exactStamp: ApprovalStamp | undefined;
    let grantConsumed = false;
    if (isExactActionApprovalEnabled()) {
      try {
        const action: ExactAction = {
          tenantId: context.tenantId,
          runId: context.runId,
          type: "SPEND",
          toolName,
          input: scopedInput,
          amountUsd,
        };
        const actionHash = computeActionHash(action);
        const grant = await consumeGrant(prisma, { tenantId: context.tenantId, runId: context.runId, actionHash });
        if (grant.ok) {
          grantConsumed = true;
          await prisma.activityLog.create({
            data: {
              tenantId: context.tenantId,
              actor: "system",
              action: "approval.consumed",
              resource: "approval",
              resourceId: grant.approvalId,
              details: { toolName, runId: context.runId, amountUsd } as any,
            },
          });
          logger.info({ toolName, approvalId: grant.approvalId }, "Exact-action grant consumed — tool may run");
        } else {
          exactStamp = buildApprovalStamp(action);
        }
      } catch (err) {
        // Un-hashable input (BigInt, non-finite number, …): never run it unbound.
        logger.error({ toolName, err: (err as Error).message }, "Exact-action binding failed — blocking");
        return {
          output: null,
          status: "FAILED",
          durationMs: Date.now() - start,
          error: `Tool "${toolName}" input cannot be bound to an approval`,
        };
      }
    }

    if (!grantConsumed) {
      const approval = await prisma.approval.create({
        data: {
          runId: context.runId,
          tenantId: context.tenantId, // SEC-BRA-05 (exactStamp below writes the same value)
          type: "SPEND",
          description,
          amountUsd: amountUsd as any,
          // BRA-UX-API-01c: riskLevel registry meta'sından; para harcayan çağrı geri alınamaz (geri alma yolu yok),
          // diğer araçlar için kaynak yok → alan yazılmaz (details.reversible null).
          metadata: {
            toolName,
            input: scopedInput,
            costField,
            moneyTouching: money,
            autonomy,
            riskLevel: meta?.riskLevel,
            ...(money ? { reversible: false } : {}),
          } as any,
          status: "PENDING",
          ...(exactStamp ?? {}),
        },
      });

      // Drive the run into WAITING_APPROVAL so the next step-group iteration
      // in the runner sees a non-RUNNING status and exits cleanly. Without
      // this the BullMQ job kept iterating and the run completed normally
      // while the approval row sat orphaned at PENDING — see ISS-022.
      if (!(await enterWaitingApproval(context.runId, context.tenantId, approval.id))) {
        return gateTransitionFailed(start);
      }

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
        localized: { title: "push.toolApprovalTitle", body: "push.toolApprovalBody", parameters: { toolName } },
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

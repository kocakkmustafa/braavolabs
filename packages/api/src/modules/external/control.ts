/**
 * External-automation CONTROL plane.
 *
 * The poller only READS. This turns the same connections into a control plane:
 * trigger a run, pause/resume the automation, stop a live execution — across
 * n8n / Make / Zapier / generic from one pane. Every action is:
 *   - capability-gated  — we refuse what the platform's API can't actually do,
 *   - tenant-scoped     — the caller already proved ownership of the row,
 *   - audited           — written to activity_log (rule #9) on success AND
 *                          failure, since each is a real tool call (rule #1).
 *
 * User-initiated control (someone clicking in the dashboard / app) is the
 * authenticated human's own decision and runs immediately. Agent-initiated
 * control is the next layer: an agent that wants to fire an external automation
 * opens an Approval row first (rule #3) and only acts once a human approves.
 * That gate is intentionally NOT in this slice — runControlAction is the shared
 * executor both paths will call once the approval layer lands.
 */
import { prisma } from "../../lib/db";
import { decrypt } from "../../lib/encryption";
import { AppError } from "../../middleware/error";
import { ADAPTERS, credentialsAad } from "./poller";
import type {
  ControlResult,
  ExternalActionType,
  ExternalCapabilities,
  ExternalWorkflowSummary,
} from "./adapters/types";

const NO_CAPS: ExternalCapabilities = {
  discover: false,
  trigger: false,
  pauseResume: false,
  stopExecution: false,
};

/** What can be controlled on a platform — drives the UI buttons + the gate. */
export function capabilitiesFor(platform: string): ExternalCapabilities {
  return ADAPTERS[platform]?.capabilities ?? NO_CAPS;
}

interface ControllableConnection {
  id: string;
  tenantId: string;
  platform: string;
  baseUrl: string;
  encryptedCredentials: string;
}

/** Decrypt the connection's credential just-in-time, or fail loudly. */
function decryptKey(conn: ControllableConnection): string {
  try {
    return decrypt(conn.encryptedCredentials, credentialsAad(conn.tenantId, conn.id));
  } catch {
    throw new AppError(502, "Credential decryption failed");
  }
}

/** List the automations on a connected platform (discover capability). */
export async function listExternalWorkflows(
  conn: ControllableConnection,
): Promise<ExternalWorkflowSummary[]> {
  const adapter = ADAPTERS[conn.platform];
  if (!adapter?.capabilities.discover || !adapter.discoverWorkflows) {
    throw new AppError(400, `${conn.platform} does not support listing automations`);
  }
  const apiKey = decryptKey(conn);
  try {
    return await adapter.discoverWorkflows({ baseUrl: conn.baseUrl, apiKey, cursor: null });
  } catch (err) {
    throw new AppError(502, `Discover failed: ${(err as Error).message.slice(0, 300)}`);
  }
}

/**
 * Run a control action against the connected platform and audit it.
 * `targetId` is platform-specific (workflow/scenario id, execution id, or — for
 * GENERIC trigger — a full https webhook URL).
 */
export async function runControlAction(args: {
  conn: ControllableConnection;
  actor: string;
  type: ExternalActionType;
  targetId: string;
}): Promise<ControlResult> {
  const { conn, actor, type, targetId } = args;
  const adapter = ADAPTERS[conn.platform];
  if (!adapter) throw new AppError(400, `No adapter for platform ${conn.platform}`);
  const caps = adapter.capabilities;

  // Map action → required capability + bound executor. Refuse anything the
  // platform can't actually back (honest control surface).
  let exec: (() => Promise<ControlResult>) | null = null;
  const cfg = { baseUrl: conn.baseUrl, apiKey: "", cursor: null as string | null };
  if (type === "TRIGGER" && caps.trigger && adapter.triggerWorkflow) {
    exec = () => adapter.triggerWorkflow!(cfg, targetId);
  } else if (type === "PAUSE" && caps.pauseResume && adapter.setActive) {
    exec = () => adapter.setActive!(cfg, targetId, false);
  } else if (type === "RESUME" && caps.pauseResume && adapter.setActive) {
    exec = () => adapter.setActive!(cfg, targetId, true);
  } else if (type === "STOP" && caps.stopExecution && adapter.stopExecution) {
    exec = () => adapter.stopExecution!(cfg, targetId);
  }
  if (!exec) throw new AppError(400, `${conn.platform} does not support ${type}`);

  cfg.apiKey = decryptKey(conn);

  try {
    const result = await exec();
    await writeAudit(conn, actor, type, targetId, true, result.detail);
    return result;
  } catch (err) {
    const message = (err as Error).message.slice(0, 300);
    await writeAudit(conn, actor, type, targetId, false, message);
    throw new AppError(502, `${type} failed: ${message}`);
  }
}

async function writeAudit(
  conn: ControllableConnection,
  actor: string,
  type: ExternalActionType,
  targetId: string,
  ok: boolean,
  detail?: string,
): Promise<void> {
  await prisma.activityLog.create({
    data: {
      tenantId: conn.tenantId,
      actor,
      action: `external.control.${type.toLowerCase()}`,
      resource: "external_connection",
      resourceId: conn.id,
      details: { platform: conn.platform, type, targetId, ok, detail },
    },
  });
}

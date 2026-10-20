/**
 * External-automation poller.
 *
 * Every 30s, finds enabled ExternalConnections that are due (per their
 * pollIntervalSec), decrypts their credentials just-in-time, calls the
 * per-platform adapter, and upserts the returned executions into ExternalRun
 * so the dashboard shows native + imported runs in one pane of glass.
 *
 * Failure-isolated: a single connection erroring sets its status=ERROR +
 * lastError and never throws into the tick loop, so one broken connection
 * can't stall polling for the rest.
 */
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { runWithoutTenant } from "../../lib/tenant-context";
import { decrypt } from "../../lib/encryption";
import { n8nAdapter } from "./adapters/n8n";
import { makeAdapter } from "./adapters/make";
import { genericAdapter } from "./adapters/generic";
import type { ExternalAdapter, NormalizedExecution } from "./adapters/types";

export const ADAPTERS: Record<string, ExternalAdapter> = {
  N8N: n8nAdapter,
  MAKE: makeAdapter,
  // Zapier has no public task-history read API, so it polls a user-exposed
  // generic JSON endpoint (a Zapier Storage/webhook collector) — same as GENERIC.
  ZAPIER: genericAdapter,
  GENERIC: genericAdapter,
};

/** AAD bound to the row so a DB-dump ciphertext can't be lifted cross-row. */
export const credentialsAad = (tenantId: string, id: string) =>
  `${tenantId}|external_connection|${id}`;

/**
 * Feature F3 — live credential validation at connect time.
 *
 * Make ONE `fetchExecutions` call against the platform with the plaintext key
 * so the onboarding flow can tell the user immediately whether the URL +
 * credential actually work, instead of silently creating a dead connection
 * they only discover is broken minutes later when the poller errors.
 *
 * Returns `{ validated: true, recentRuns }` on success or
 * `{ validated: false, validationError }` on any failure. NEVER throws — a
 * validation failure must not block creating the row (the connection is still
 * saved; the UI just flags its health and the poller will retry on schedule).
 */
export async function validateConnectionCredentials(args: {
  platform: string;
  baseUrl: string;
  apiKey: string;
}): Promise<{ validated: boolean; recentRuns?: number; validationError?: string }> {
  const adapter = ADAPTERS[args.platform];
  if (!adapter) {
    return { validated: false, validationError: `No adapter for platform ${args.platform}` };
  }
  try {
    const { executions } = await adapter.fetchExecutions({
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      cursor: null,
    });
    return { validated: true, recentRuns: executions.length };
  } catch (err) {
    return { validated: false, validationError: (err as Error).message.slice(0, 300) };
  }
}

interface PollableConnection {
  id: string;
  tenantId: string;
  platform: string;
  baseUrl: string;
  encryptedCredentials: string;
  cursor: string | null;
}

// Manual refresh and the scheduled sweep share the same in-process admission
// point. The DB upsert alone does not prevent duplicate provider requests.
const activePolls = new Map<string, Promise<void>>();

export function pollConnection(conn: PollableConnection): Promise<void> {
  const active = activePolls.get(conn.id);
  if (active) return active;
  const pending = pollConnectionImpl(conn).finally(() => {
    if (activePolls.get(conn.id) === pending) activePolls.delete(conn.id);
  });
  activePolls.set(conn.id, pending);
  return pending;
}

async function pollConnectionImpl(conn: PollableConnection): Promise<void> {
  const adapter = ADAPTERS[conn.platform];
  if (!adapter) {
    await prisma.externalConnection.update({
      where: { id: conn.id },
      data: { status: "ERROR", lastError: `No adapter for platform ${conn.platform}`, lastPolledAt: new Date() },
    });
    return;
  }

  let apiKey: string;
  try {
    apiKey = decrypt(conn.encryptedCredentials, credentialsAad(conn.tenantId, conn.id));
  } catch {
    await prisma.externalConnection.update({
      where: { id: conn.id },
      data: { status: "ERROR", lastError: "Credential decryption failed", lastPolledAt: new Date() },
    });
    return;
  }

  try {
    const { executions, cursor } = await adapter.fetchExecutions({
      baseUrl: conn.baseUrl,
      apiKey,
      cursor: conn.cursor,
    });

    for (const ex of executions) {
      await upsertExternalRun(conn.id, ex);
    }

    await prisma.externalConnection.update({
      where: { id: conn.id },
      data: {
        status: "ACTIVE",
        lastError: null,
        lastPolledAt: new Date(),
        ...(cursor ? { cursor } : {}),
      },
    });
    logger.info(
      { connectionId: conn.id, platform: conn.platform, count: executions.length },
      "External connection polled",
    );
  } catch (err) {
    await prisma.externalConnection.update({
      where: { id: conn.id },
      data: { status: "ERROR", lastError: (err as Error).message.slice(0, 500), lastPolledAt: new Date() },
    });
  }
}

async function upsertExternalRun(connectionId: string, ex: NormalizedExecution): Promise<void> {
  const startedAt = ex.startedAt ? new Date(ex.startedAt) : null;
  const finishedAt = ex.finishedAt ? new Date(ex.finishedAt) : null;
  await prisma.externalRun.upsert({
    where: { connectionId_externalId: { connectionId, externalId: ex.externalId } },
    create: {
      connectionId,
      externalId: ex.externalId,
      workflowName: ex.workflowName ?? null,
      status: ex.status,
      startedAt,
      finishedAt,
      raw: (ex.raw ?? undefined) as any,
    },
    update: {
      status: ex.status,
      workflowName: ex.workflowName ?? null,
      finishedAt,
      raw: (ex.raw ?? undefined) as any,
    },
  });
}

let timer: ReturnType<typeof setInterval> | null = null;
let activeTick: Promise<void> | null = null;
let sweepAfterId: string | undefined;
let pollerEpoch = 0;
const PAGE_SIZE = 100;
const MAX_SCAN_PER_TICK = 1000;
const MAX_POLLS_PER_TICK = 100;

async function tick(): Promise<void> {
  if (activeTick) return activeTick;
  // BR-P0-004: polls every enabled connection across all tenants.
  const pending = runWithoutTenant("cron:external-poller", () => tickImpl(pollerEpoch));
  activeTick = pending;
  try {
    await pending;
  } finally {
    if (activeTick === pending) activeTick = null;
  }
}

async function tickImpl(epoch: number): Promise<void> {
  const now = Date.now();
  let scanned = 0;
  let polled = 0;
  while (scanned < MAX_SCAN_PER_TICK && polled < MAX_POLLS_PER_TICK && epoch === pollerEpoch) {
    // Stable keyset traversal also visits rows after a not-yet-due first page.
    // Keep the cursor across bounded ticks; do not restart at the first 100.
    const conns = await prisma.externalConnection.findMany({
      where: { enabled: true, ...(sweepAfterId ? { id: { gt: sweepAfterId } } : {}) },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
    });
    if (epoch !== pollerEpoch) return;
    if (conns.length === 0) {
      sweepAfterId = undefined;
      return;
    }
    for (const c of conns) {
      if (epoch !== pollerEpoch) return;
      sweepAfterId = c.id;
      scanned++;
      if (!c.lastPolledAt || now - c.lastPolledAt.getTime() >= c.pollIntervalSec * 1000) {
        polled++;
        await pollConnection(c).catch((err) =>
          logger.warn({ connectionId: c.id, err: (err as Error).message }, "pollConnection threw (isolated)"),
        );
      }
      if (scanned >= MAX_SCAN_PER_TICK || polled >= MAX_POLLS_PER_TICK) return;
    }
    if (conns.length < PAGE_SIZE) {
      sweepAfterId = undefined;
      return;
    }
  }
}

/** Start the 30s poll loop. Call once on server startup. */
export function initExternalPoller(): void {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((err) => logger.error({ err: (err as Error).message }, "External poller tick failed"));
  }, 30_000);
  logger.info("External automation poller initialized (30s tick)");
}

export function stopExternalPoller(): void {
  pollerEpoch++;
  sweepAfterId = undefined;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

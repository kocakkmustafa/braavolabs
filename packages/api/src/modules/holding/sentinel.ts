import { createHash } from "crypto";
import { prisma } from "../../lib/db";
import { logger } from "../../lib/logger";
import { audit } from "./audit";
import type { HoldingSeverityStr, HoldingTrustLevelStr } from "./types";

/**
 * Nöbetçi S0 ingest + heartbeat layer (FABLE_PLAN §5B).
 *
 * "Nöbetçi konuşmaz, nabız tutar": this file is deterministic — sensors
 * write events, dedup folds copies, heartbeat freshness is checked by a
 * timer. NO LLM lives here; S1/S2 patrol layers arrive in a later package
 * and will consume `holding_sentinel_events` as their queue.
 *
 * Hard rules encoded here (opsiyonel değil — adversarial denetim şartları):
 *  - Dedup may never delete an event or LOWER its severity.
 *  - A missing heartbeat is itself an event ("kör olduğu için $0" ile
 *    "sakin olduğu için $0" ayırt edilemez).
 */

const SEVERITY_ORDER: Record<HoldingSeverityStr, number> = {
  SEV0: 0,
  SEV1: 1,
  SEV2: 2,
  SEV3: 3,
  INFO: 4,
};

/** Returns the MORE severe of the two (lower order wins). */
export function maxSeverity(a: HoldingSeverityStr, b: HoldingSeverityStr): HoldingSeverityStr {
  return SEVERITY_ORDER[a] <= SEVERITY_ORDER[b] ? a : b;
}

export function fingerprintOf(source: string, kind: string, salient: string): string {
  return createHash("sha256").update(`${source}|${kind}|${salient}`).digest("hex");
}

export interface IngestInput {
  source: string;
  kind: string;
  severity: HoldingSeverityStr;
  /** Provenance of the CONTENT — external mail/webhook bodies are UNTRUSTED. */
  trustLevel?: HoldingTrustLevelStr;
  payload?: Record<string, unknown>;
  /** Dedup key material; defaults to kind (thread-level dedup is caller's job). */
  salient?: string;
  /** SEV0 fan-out (Telegram vb.) — injected so this module stays pure-ish. */
  onSev0?: (eventId: string, input: IngestInput) => Promise<void>;
}

export async function ingestSentinelEvent(input: IngestInput): Promise<{ id: string; deduped: boolean }> {
  const fingerprint = fingerprintOf(input.source, input.kind, input.salient ?? input.kind);

  const existing = await prisma.holdingSentinelEvent.findFirst({
    where: { fingerprint, status: { in: ["NEW", "CLASSIFIED", "ESCALATED"] } },
  });

  if (existing) {
    // Fold the copy — but severity may only ever RISE.
    const severity = maxSeverity(existing.severity as HoldingSeverityStr, input.severity);
    await prisma.holdingSentinelEvent.update({
      where: { id: existing.id },
      data: { dedupCount: { increment: 1 }, lastSeenAt: new Date(), severity },
    });
    return { id: existing.id, deduped: true };
  }

  const event = await prisma.holdingSentinelEvent.create({
    data: {
      source: input.source,
      kind: input.kind,
      severity: input.severity,
      trustLevel: input.trustLevel ?? "UNTRUSTED",
      payload: (input.payload ?? {}) as object,
      fingerprint,
      status: input.severity === "SEV0" ? "ESCALATED" : "NEW",
    },
  });

  await audit({
    actor: "sentinel.s0",
    action: "sentinel.event_ingested",
    entity: "holding_sentinel_event",
    entityId: event.id,
    payload: { source: input.source, kind: input.kind, severity: input.severity },
  });

  if (input.severity === "SEV0") {
    // Hard SEV0 skips every patrol cadence — direct fan-out, cron beklemez.
    logger.error({ eventId: event.id, source: input.source, kind: input.kind }, "SEV0 sentinel event");
    try {
      await input.onSev0?.(event.id, input);
    } catch (err) {
      logger.error({ err, eventId: event.id }, "SEV0 fan-out failed (event is persisted regardless)");
    }
  }

  return { id: event.id, deduped: false };
}

/** Sensors call this on every successful cycle (dead-man's switch feed). */
export async function heartbeat(sensorId: string, intervalSeconds: number): Promise<void> {
  await prisma.holdingHeartbeat.upsert({
    where: { sensorId },
    create: { sensorId, intervalSeconds, lastBeatAt: new Date() },
    update: { intervalSeconds, lastBeatAt: new Date() },
  });
}

/**
 * Dead-man's switch sweep: a sensor that missed 2× its interval becomes a
 * SEV1 event. Fingerprint is per sensor+day so a dead sensor alarms once a
 * day (dedupCount then counts the sweeps), not once per sweep.
 */
export async function checkHeartbeats(now: Date = new Date()): Promise<number> {
  const beats = await prisma.holdingHeartbeat.findMany();
  let missed = 0;
  for (const beat of beats) {
    const staleMs = now.getTime() - beat.lastBeatAt.getTime();
    if (staleMs > 2 * beat.intervalSeconds * 1000) {
      missed += 1;
      await ingestSentinelEvent({
        source: "heartbeat-monitor",
        kind: "heartbeat-missed",
        severity: "SEV1",
        trustLevel: "TRUSTED",
        payload: { sensorId: beat.sensorId, staleSeconds: Math.round(staleMs / 1000) },
        salient: `${beat.sensorId}|${now.toISOString().slice(0, 10)}`,
      });
    }
  }
  return missed;
}

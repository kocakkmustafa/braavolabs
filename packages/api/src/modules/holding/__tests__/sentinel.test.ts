import { describe, it, expect, vi, beforeEach } from "vitest";

// Stateful in-memory prisma fake covering only what sentinel.ts touches.
const state = vi.hoisted(() => ({
  events: [] as any[],
  heartbeats: [] as any[],
  audits: [] as any[],
  seq: 0,
}));

const prismaMock = vi.hoisted(() => ({
  holdingSentinelEvent: {
    findFirst: vi.fn(async ({ where }: any) =>
      state.events.find(
        (e) => e.fingerprint === where.fingerprint && where.status.in.includes(e.status),
      ) ?? null,
    ),
    create: vi.fn(async ({ data }: any) => {
      const event = { id: `ev_${++state.seq}`, dedupCount: 1, ...data };
      state.events.push(event);
      return event;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const event = state.events.find((e) => e.id === where.id);
      if (data.dedupCount?.increment) event.dedupCount += data.dedupCount.increment;
      if (data.severity) event.severity = data.severity;
      if (data.lastSeenAt) event.lastSeenAt = data.lastSeenAt;
      return event;
    }),
  },
  holdingHeartbeat: {
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const existing = state.heartbeats.find((h) => h.sensorId === where.sensorId);
      if (existing) return Object.assign(existing, update);
      const beat = { id: `hb_${++state.seq}`, ...create };
      state.heartbeats.push(beat);
      return beat;
    }),
    findMany: vi.fn(async () => state.heartbeats),
  },
  holdingAuditLog: {
    create: vi.fn(async ({ data }: any) => {
      state.audits.push(data);
      return data;
    }),
  },
}));

vi.mock("../../../lib/db", () => ({ prisma: prismaMock }));

import { ingestSentinelEvent, checkHeartbeats, heartbeat, maxSeverity } from "../sentinel";

beforeEach(() => {
  state.events.length = 0;
  state.heartbeats.length = 0;
  state.audits.length = 0;
});

describe("maxSeverity", () => {
  it("never lowers severity", () => {
    expect(maxSeverity("SEV2", "SEV0")).toBe("SEV0");
    expect(maxSeverity("SEV0", "SEV3")).toBe("SEV0");
    expect(maxSeverity("INFO", "SEV3")).toBe("SEV3");
  });
});

describe("ingestSentinelEvent", () => {
  it("creates an event and audits it", async () => {
    const res = await ingestSentinelEvent({
      source: "mail-filter",
      kind: "asc-mail",
      severity: "SEV2",
      salient: "thread-1",
    });
    expect(res.deduped).toBe(false);
    expect(state.events).toHaveLength(1);
    expect(state.events[0].trustLevel).toBe("UNTRUSTED"); // external default
    expect(state.audits.some((a) => a.action === "sentinel.event_ingested")).toBe(true);
  });

  it("dedups copies but NEVER lowers severity", async () => {
    await ingestSentinelEvent({ source: "s", kind: "k", severity: "SEV1", salient: "x" });
    const res = await ingestSentinelEvent({ source: "s", kind: "k", severity: "SEV3", salient: "x" });
    expect(res.deduped).toBe(true);
    expect(state.events).toHaveLength(1);
    expect(state.events[0].dedupCount).toBe(2);
    expect(state.events[0].severity).toBe("SEV1"); // kept the MORE severe
  });

  it("escalates SEV0 immediately and survives a failing fan-out", async () => {
    const res = await ingestSentinelEvent({
      source: "cost-guard",
      kind: "spend-rate",
      severity: "SEV0",
      onSev0: async () => {
        throw new Error("telegram down");
      },
    });
    expect(res.deduped).toBe(false);
    expect(state.events[0].status).toBe("ESCALATED");
  });
});

describe("dead-man's switch", () => {
  it("a missing heartbeat becomes a SEV1 event", async () => {
    const now = new Date("2026-07-26T12:00:00Z");
    await heartbeat("uptime-kuma", 60);
    // Manually age the beat far past 2× its interval.
    state.heartbeats[0].lastBeatAt = new Date(now.getTime() - 10 * 60_000);
    const missed = await checkHeartbeats(now);
    expect(missed).toBe(1);
    expect(state.events.some((e) => e.kind === "heartbeat-missed" && e.severity === "SEV1")).toBe(true);
  });

  it("a fresh heartbeat raises nothing", async () => {
    const now = new Date("2026-07-26T12:00:00Z");
    await heartbeat("uptime-kuma", 60);
    state.heartbeats[0].lastBeatAt = new Date(now.getTime() - 30_000);
    expect(await checkHeartbeats(now)).toBe(0);
    expect(state.events).toHaveLength(0);
  });
});

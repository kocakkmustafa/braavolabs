import { describe, it, expect, vi, beforeEach } from "vitest";

const ingestMock = vi.hoisted(() => vi.fn(async () => ({ id: "ev_1", deduped: false })));
const heartbeatMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../sentinel", () => ({ ingestSentinelEvent: ingestMock, heartbeat: heartbeatMock }));

const sev0AlertMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../telegram", () => ({ sendSev0Alert: sev0AlertMock }));

const queueCountsMock = vi.hoisted(() => vi.fn(async () => ({ failed: 0 })));
vi.mock("../../../lib/queue", () => ({
  holdingRunQueue: { getJobCounts: queueCountsMock },
}));

import { classifyMail, ingestMailSignal, sweepSentinelSensors, costRateAlarm, QUEUE_FAILED_THRESHOLD } from "../sensors";

beforeEach(() => {
  ingestMock.mockClear();
  heartbeatMock.mockClear();
  sev0AlertMock.mockClear();
  queueCountsMock.mockClear();
  queueCountsMock.mockResolvedValue({ failed: 0 });
});

describe("classifyMail — table-driven S0 routing", () => {
  it("Apple rejection is a SEV1 hard signal with venture attribution", () => {
    const signal = classifyMail({
      from: "no_reply@email.apple.com",
      subject: "App Review: Burun Farkı has been rejected",
    });
    expect(signal).toEqual({ kind: "store-apple-rejection", severity: "SEV1", venture: "burun-farki" });
  });

  it("Turkish rejection wording is caught too", () => {
    const signal = classifyMail({ from: "noreply@apple.com", subject: "LifeOS başvurunuz reddedildi" });
    expect(signal.severity).toBe("SEV1");
    expect(signal.venture).toBe("lifeos");
  });

  it("Play policy deadline mail is SEV1", () => {
    const signal = classifyMail({
      from: "googleplay-noreply@google.com",
      subject: "Action required: policy deadline for Braavolabs",
    });
    expect(signal).toEqual({ kind: "store-google-policy", severity: "SEV1", venture: "braavolabs" });
  });

  it("good news is INFO, ordinary store mail is SEV2", () => {
    expect(classifyMail({ from: "x@apple.com", subject: "Gravita is now available" }).severity).toBe("INFO");
    expect(classifyMail({ from: "x@apple.com", subject: "Your monthly newsletter" }).severity).toBe("SEV2");
  });

  it("supabase pause/limit alerts are SEV1, the rest SEV3; unknown senders INFO", () => {
    expect(classifyMail({ from: "noreply@supabase.io", subject: "Project paused" }).severity).toBe("SEV1");
    expect(classifyMail({ from: "noreply@supabase.io", subject: "Weekly digest" }).severity).toBe("SEV3");
    expect(classifyMail({ from: "someone@example.com", subject: "merhaba" }).severity).toBe("INFO");
  });
});

describe("ingestMailSignal", () => {
  it("feeds the classifier output into sentinel as UNTRUSTED with messageId dedup", async () => {
    await ingestMailSignal({
      from: "noreply@apple.com",
      subject: "LifeOS rejected",
      messageId: "<m1@apple>",
      snippet: "x".repeat(1000),
    });
    expect(ingestMock).toHaveBeenCalledOnce();
    const arg = ingestMock.mock.calls[0][0];
    expect(arg.trustLevel).toBe("UNTRUSTED");
    expect(arg.salient).toBe("<m1@apple>");
    expect(arg.payload.snippet.length).toBe(500); // excerpt is capped
  });
});

describe("sweepSentinelSensors", () => {
  it("always beats its own heartbeat (the sweep is on the dead-man's switch)", async () => {
    await sweepSentinelSensors();
    expect(heartbeatMock).toHaveBeenCalledWith("holding-sensor-sweep", 600);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("raises a per-day SEV2 when dead-letter depth crosses the threshold", async () => {
    queueCountsMock.mockResolvedValue({ failed: QUEUE_FAILED_THRESHOLD });
    await sweepSentinelSensors();
    const arg = ingestMock.mock.calls[0][0];
    expect(arg.kind).toBe("holding-dead-letter");
    expect(arg.severity).toBe("SEV2");
  });

  it("a queue probe failure never kills the sweep (heartbeat already sent)", async () => {
    queueCountsMock.mockRejectedValue(new Error("redis down"));
    await expect(sweepSentinelSensors()).resolves.toBeUndefined();
    expect(heartbeatMock).toHaveBeenCalled();
  });
});

describe("costRateAlarm", () => {
  it("persists a SEV0 event whose fan-out sends the Telegram alert", async () => {
    ingestMock.mockImplementation(async (input: any) => {
      // sentinel calls onSev0 for SEV0 events — simulate that contract.
      await input.onSev0?.("ev_9", input);
      return { id: "ev_9", deduped: false };
    });
    await costRateAlarm(2.4);
    expect(ingestMock.mock.calls[0][0].severity).toBe("SEV0");
    expect(sev0AlertMock).toHaveBeenCalledOnce();
    expect(String(sev0AlertMock.mock.calls[0][0])).toContain("2.40");
  });
});

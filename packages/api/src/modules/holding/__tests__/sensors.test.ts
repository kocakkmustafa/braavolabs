import { describe, it, expect, vi, beforeEach } from "vitest";

const ingestMock = vi.hoisted(() => vi.fn(async () => ({ id: "ev_1", deduped: false })));
const heartbeatMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../sentinel", () => ({ ingestSentinelEvent: ingestMock, heartbeat: heartbeatMock }));

const sev0AlertMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../telegram", () => ({ sendSev0Alert: sev0AlertMock }));

const prismaMock = vi.hoisted(() => ({
  holdingWorkflowRun: { count: vi.fn(async () => 7) },
  holdingStepRun: { count: vi.fn(async () => 0) },
  holdingApproval: { count: vi.fn(async () => 1) },
}));
vi.mock("../../../lib/db", () => ({ prisma: prismaMock }));

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
  prismaMock.holdingStepRun.count.mockResolvedValue(0);
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

describe("classifyMail — kutu-düzeyi venture atıfı", () => {
  it("konu sessizse KUTU sahibi venture'ı belirler", () => {
    const s = classifyMail({
      from: "no_reply@email.apple.com",
      subject: "Your app status has changed",     // hiçbir ürün adı geçmiyor
      mailboxVenture: "burun-farki",
    });
    expect(s.venture).toBe("burun-farki");
  });

  it("konu AÇIKÇA başka ürünü söylüyorsa kutu sahibini EZMEZ", () => {
    // Tek kutuya birden çok ürünün postası düşebilir; açık kanıt tahminden güçlü.
    const s = classifyMail({
      from: "no_reply@email.apple.com",
      subject: "LifeOS 1.6.0 is now available",
      mailboxVenture: "burun-farki",
    });
    expect(s.venture).toBe("lifeos");
  });

  it("kutu bilgisi yoksa eski davranış korunur (null)", () => {
    expect(classifyMail({ from: "x@y.z", subject: "merhaba" }).venture).toBeNull();
  });
});

describe("classifyMail — dependabot gürültüsü", () => {
  it("bağımlılık bump bildirimi CI OLAYI değildir (SEV3), ama BAŞARISIZ olanı sinyaldir", () => {
    const bump = classifyMail({
      from: '"dependabot[bot]" <notifications@github.com>',
      subject: "[kocakkmustafa/lifeos] chore(deps): Bump flutter_riverpod from 3.3.2 to 3.4.2",
    });
    expect(bump.kind).toBe("ci-bagimlilik-bildirimi");
    expect(bump.severity).toBe("SEV3");

    // Aynı bump PR'ı DÜŞTÜYSE gerçek bir CI hatasıdır — kural onu yutmamalı.
    const dusen = classifyMail({
      from: '"dependabot[bot]" <notifications@github.com>',
      subject: "[kocakkmustafa/lifeos] Run failed: checks — bump deps",
    });
    expect(dusen.kind).toBe("ci-failure-mail");
    expect(dusen.severity).toBe("SEV2");
  });

  it("sıradan CI hatası etkilenmez", () => {
    const s = classifyMail({
      from: "notifications@github.com",
      subject: "[kocakkmustafa/lissom] Run failed: checks - main (67f63a7)",
    });
    expect(s.kind).toBe("ci-failure-mail");
    expect(s.venture).toBe("lissom");
  });
});

describe("sweepSentinelSensors", () => {
  it("always beats its own heartbeat (the sweep is on the dead-man's switch)", async () => {
    await sweepSentinelSensors();
    expect(heartbeatMock).toHaveBeenCalledWith("holding-sensor-sweep", 600);
    // Kuyruk sağlıklı → dead-letter olayı YOK. Ama motor-saglik HER turda
    // üretilir: "hata yok" bilgisi günlük brief'in bir satırıdır ve yalnız
    // bozukken üretmek "sessizlik = her şey yolunda" yanılgısı doğurur.
    const kinds = ingestMock.mock.calls.map((c: any[]) => c[0].kind);
    expect(kinds).not.toContain("holding-dead-letter");
    expect(kinds).toContain("motor-saglik");
  });

  it("motor-saglik sağlıklı günde INFO, başarısız adım varsa SEV2", async () => {
    await sweepSentinelSensors();
    const saglikli = ingestMock.mock.calls.map((c: any[]) => c[0]).find((a: any) => a.kind === "motor-saglik");
    expect(saglikli.severity).toBe("INFO");
    expect(saglikli.payload.bekleyenOnay).toBe(1);

    ingestMock.mockClear();
    prismaMock.holdingStepRun.count.mockResolvedValueOnce(2);
    await sweepSentinelSensors();
    const bozuk = ingestMock.mock.calls.map((c: any[]) => c[0]).find((a: any) => a.kind === "motor-saglik");
    expect(bozuk.severity).toBe("SEV2");
  });

  it("raises a per-day SEV2 when dead-letter depth crosses the threshold", async () => {
    queueCountsMock.mockResolvedValue({ failed: QUEUE_FAILED_THRESHOLD });
    await sweepSentinelSensors();
    const arg = ingestMock.mock.calls.map((c: any[]) => c[0]).find((a: any) => a.kind === "holding-dead-letter");
    expect(arg).toBeDefined();
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

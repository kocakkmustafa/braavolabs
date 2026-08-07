import { describe, expect, it, vi } from "vitest";

// Mevcut testlerle aynı desen: env/prisma/logger dış dünyaya dokunmasın.
const envMock = vi.hoisted(() => ({ HOLDING_ENABLED: false }));
vi.mock("../../../config/env", () => ({ env: envMock }));
vi.mock("../../../lib/db", () => ({ prisma: { holdingAuditLog: { create: vi.fn() } } }));
vi.mock("../../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
import {
  loadSlackConfig,
  notifySlack,
  renderDailyDigest,
  type SlackEvent,
} from "../slack";

/**
 * Slack raporlama katmanı (D5, kurucu kararı 2026-08-07).
 * Sözleşme: dormant-by-default, yönlendirme kaybetmez, asla fırlatmaz.
 */

const okFetch = () =>
  vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "ok" } as never);

function ev(over: Partial<SlackEvent> = {}): SlackEvent {
  return {
    kind: "publish.succeeded",
    project: "lifeos",
    title: "test olayı",
    ...over,
  } as SlackEvent;
}

describe("slack config", () => {
  it("marka webhook'larını env'den toplar (braavo kısaltması dahil)", () => {
    const cfg = loadSlackConfig({
      SLACK_WEBHOOK_YULALAB: "https://hooks/yula",
      SLACK_WEBHOOK_BRAAVO: "https://hooks/braavo",
      SLACK_WEBHOOK_HOLDING: "https://hooks/holding",
    } as NodeJS.ProcessEnv);
    expect(cfg.webhooks.yulalab).toBe("https://hooks/yula");
    expect(cfg.webhooks.braavolabs).toBe("https://hooks/braavo");
    expect(cfg.fallback).toBe("https://hooks/holding");
  });

  it("boş string'i dolu saymaz", () => {
    const cfg = loadSlackConfig({ SLACK_WEBHOOK_LIFEOS: "   " } as NodeJS.ProcessEnv);
    expect(cfg.webhooks.lifeos).toBeUndefined();
  });
});

describe("notifySlack", () => {
  it("HOLDING_ENABLED yokken sessiz no-op (dormant sözleşmesi)", async () => {
    const fetchImpl = okFetch();
    const sent = await notifySlack(ev(), { fetchImpl: fetchImpl as never });
    expect(sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("proje kanalı tanımlıysa oraya gönderir", async () => {
    const fetchImpl = okFetch();
    const sent = await notifySlack(ev({ project: "lifeos" }), {
      force: true,
      fetchImpl: fetchImpl as never,
      config: { webhooks: { lifeos: "https://hooks/lifeos" }, fallback: "https://hooks/holding" },
    });
    expect(sent).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://hooks/lifeos");
  });

  it("proje kanalı yoksa holding kanalına DÜŞER — olay kaybolmaz", async () => {
    const fetchImpl = okFetch();
    await notifySlack(ev({ project: "burunfarki" }), {
      force: true,
      fetchImpl: fetchImpl as never,
      config: { webhooks: {}, fallback: "https://hooks/holding" },
    });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://hooks/holding");
  });

  it("hiç webhook yoksa fırlatmaz, false döner", async () => {
    const sent = await notifySlack(ev(), { force: true, config: { webhooks: {} } });
    expect(sent).toBe(false);
  });

  it("Slack çökerse iş DURMAZ (fırlatmaz)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("slack down"));
    const sent = await notifySlack(ev(), {
      force: true,
      fetchImpl: fetchImpl as never,
      config: { webhooks: { lifeos: "https://hooks/x" } },
    });
    expect(sent).toBe(false);
  });

  it("gövdede başlık ve olay tipi taşınır", async () => {
    const fetchImpl = okFetch();
    await notifySlack(ev({ title: "LifeOS yayınlandı", url: "https://t.me/x/1" }), {
      force: true,
      fetchImpl: fetchImpl as never,
      config: { webhooks: { lifeos: "https://hooks/x" } },
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(body.text).toContain("LifeOS yayınlandı");
    expect(JSON.stringify(body.blocks)).toContain("publish.succeeded");
    expect(JSON.stringify(body.blocks)).toContain("https://t.me/x/1");
  });
});

describe("günlük özet", () => {
  it("sayımları ve yayınlananları özetler", () => {
    const { text } = renderDailyDigest({
      project: "lifeos",
      day: "2026-08-07",
      events: [
        ev({ kind: "publish.succeeded", title: "IG paylaşıldı", url: "https://ig/1" }),
        ev({ kind: "publish.succeeded", title: "Threads paylaşıldı" }),
        ev({ kind: "publish.failed", title: "TikTok patladı" }),
        ev({ kind: "approval.requested", title: "onay" }),
        ev({ kind: "approval.granted", title: "onaylandı" }),
      ],
    });
    expect(text).toContain("2026-08-07");
    expect(text).toContain("2 yayınlandı");
    expect(text).toContain("1 istendi");
    expect(text).toContain("IG paylaşıldı");
    expect(text).toContain("TikTok patladı");
  });

  it("olay yoksa boş gün der (yanıltıcı sayı basmaz)", () => {
    const { text } = renderDailyDigest({ project: "holding", day: "2026-08-07", events: [] });
    expect(text).toContain("kayda değer bir olay yok");
  });
});

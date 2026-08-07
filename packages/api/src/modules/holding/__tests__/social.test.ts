import { describe, expect, it, vi } from "vitest";

// Mevcut testlerle aynı desen: env/prisma/logger dış dünyaya dokunmasın.
const envMock = vi.hoisted(() => ({ HOLDING_ENABLED: false }));
vi.mock("../../../config/env", () => ({ env: envMock }));
vi.mock("../../../lib/db", () => ({ prisma: { holdingAuditLog: { create: vi.fn() } } }));
vi.mock("../../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
import { checkCaption, validateAll } from "../social/compliance";
import { shouldRetry, publish, MAX_ATTEMPTS } from "../social/index";
import { qTime } from "../social/queue";
import { renderBrandDigest } from "../social/digest";
import { failed, type PublishResult, type SocialPost } from "../social/types";
import { processCallbacks, publishReady, runTurn } from "../social/orchestrator";

/**
 * Sosyal yayın hattı — Mac'te canlı kanıtlanan Python kodunun TS portu.
 * Buradaki testler o kodun ÖĞRENDİĞİ dersleri kilitler.
 */

// Kuyruk katmanı Supabase konfigürasyonu ister; testte sahte değer yeterli
// (her HTTP çağrısı fetchImpl ile mock'lanıyor, gerçek ağa çıkılmıyor).
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://test.supabase.co";
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? "sb_secret_test";

describe("compliance kapısı", () => {
  it("Burun Farkı yasak kelimelerini yakalar (kuyruğa girmeden)", () => {
    const res = checkCaption("burunfarki", "Bu kupon garantili kazandırır");
    expect(res.ok).toBe(false);
    expect(res.issues).toContain("forbidden_word:garantili");
  });

  it("temiz Burun Farkı içeriğine Yeşilay footer'ını OTOMATİK ekler", () => {
    const res = checkCaption("burunfarki", "Bugünkü analiz: model isabet oranı %68");
    expect(res.ok).toBe(true);
    expect(res.fixedCaption).toContain("18+ · Yeşilay 182");
  });

  it("footer zaten varsa ikinci kez eklemez", () => {
    const once = checkCaption("burunfarki", "Analiz")!.fixedCaption!;
    const twice = checkCaption("burunfarki", once);
    expect(twice.fixedCaption).toBeUndefined();
  });

  it("diğer markalarda footer eklemez", () => {
    const res = checkCaption("lifeos", "Calm tech for intentional living");
    expect(res.ok).toBe(true);
    expect(res.fixedCaption).toBeUndefined();
  });

  it("engagement-bait tüm markalarda yasak", () => {
    expect(checkCaption("yulalab", "Takip et kazan!").ok).toBe(false);
  });

  it("validateAll bir caption kirliyse hepsini raporlar", () => {
    const { issues, fixed } = validateAll("burunfarki", {
      tiktok: "garantili kazanç",
      instagram_feed: "dürüst analiz",
    });
    expect(issues.some((i) => i.startsWith("tiktok:"))).toBe(true);
    expect(fixed.instagram_feed).toContain("Yeşilay");
  });
});

describe("yeniden deneme politikası (kurucu kararı 2026-08-07)", () => {
  const r = (error: string): PublishResult => failed("tiktok", error);

  it("yayın BAŞLAMADAN önceki geçici hatalarda tekrar dener", () => {
    expect(shouldRetry(r("ağ hatası: connection refused"), 1, "yulalab")).toBe(true);
    expect(shouldRetry(r("container oluşturulamadı: ağ hatası"), 1, "yulalab")).toBe(true);
    expect(shouldRetry(r("medya indirilemedi: HTTP 503"), 1, "yulalab")).toBe(true);
  });

  it("BELİRSİZ durumlarda ASLA tekrar denemez (çift post riski)", () => {
    expect(shouldRetry(r("chunk yükleme ağ hatası (offset=5242880)"), 1, "yulalab")).toBe(false);
    expect(shouldRetry(r("TikTok yayın zaman aşımı (600s)"), 1, "yulalab")).toBe(false);
    expect(shouldRetry(r("yükleme reddedildi: HTTP 503"), 1, "yulalab")).toBe(false);
    expect(shouldRetry(r("publish başarısız: timeout"), 1, "yulalab")).toBe(false);
  });

  it("kalıcı hatalarda tekrar denemez", () => {
    expect(shouldRetry(r("Invalid OAuth access token (code=190)"), 1, "yulalab")).toBe(false);
    expect(shouldRetry(r("Telegram reddetti: chat not found"), 1, "yulalab")).toBe(false);
  });

  it("deneme sınırını aşmaz", () => {
    expect(shouldRetry(r("ağ hatası"), MAX_ATTEMPTS, "yulalab")).toBe(false);
  });
});

describe("manuel platformlar", () => {
  it("Reddit API'den yayınlanmaz — kalıcı kurucu kararı", async () => {
    const res = await publish({
      brand: "yulalab",
      platform: "reddit",
      caption: "x",
      mediaUrls: [],
      mediaKind: "none",
    });
    expect(res.status).toBe("manual_required");
    expect(res.error).toContain("kurucu kararı");
  });

  it("X kalıcı iptal", async () => {
    const res = await publish({
      brand: "yulalab",
      platform: "x",
      caption: "x",
      mediaUrls: [],
      mediaKind: "none",
    });
    expect(res.status).toBe("manual_required");
  });

  it("tanımsız platform net hata verir", async () => {
    const res = await publish({
      brand: "yulalab",
      platform: "myspace" as never,
      caption: "x",
      mediaUrls: [],
      mediaKind: "none",
    });
    expect(res.status).toBe("failed");
    expect(res.error).toContain("tanımsız platform");
  });
});

describe("PostgREST zaman damgası tuzağı", () => {
  it("`+00:00` ÜRETMEZ — URL'de boşluğa dönüşüp 22007 veriyordu", () => {
    const t = qTime(new Date("2026-08-07T21:49:55.536Z"));
    expect(t).not.toContain("+");
    expect(t.endsWith("Z")).toBe(true);
  });
});

describe("orkestratör", () => {
  const row = (over: Record<string, unknown> = {}) =>
    ({
      id: 1,
      brand: "lifeos",
      platform: "telegram",
      caption: "merhaba",
      media_urls: [],
      media_kind: "none",
      hashtags: [],
      status: "approved",
      approval_status: "approved",
      approval_deadline: null,
      approved_by: "founder",
      telegram_msg_id: null,
      retries: 0,
      ...over,
    }) as never;

  it("başarılı yayını Slack'e 'publish.succeeded' olarak raporlar", async () => {
    const events: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("post_queue?status=eq.approved")) {
        return { ok: true, status: 200, text: async () => JSON.stringify([row()]) } as never;
      }
      return { ok: true, status: 200, text: async () => "[]" } as never;
    });
    const res = await publishReady({
      fetchImpl: fetchImpl as never,
      publishImpl: async () => ({
        platform: "telegram",
        status: "published",
        platformPostId: "3",
        platformUrl: "https://t.me/yulalab/3",
      }),
      notifyImpl: async (e) => {
        events.push(e.kind);
        return true;
      },
    });
    expect(res.published).toHaveLength(1);
    expect(events).toContain("publish.succeeded");
  });

  it("başarısız yayını SEV2 olarak raporlar ve failed işaretler", async () => {
    const events: Array<{ kind: string; severity?: string }> = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("post_queue?status=eq.approved")) {
        return { ok: true, status: 200, text: async () => JSON.stringify([row()]) } as never;
      }
      if (u.includes("post_queue?id=eq.1&select=retries")) {
        return { ok: true, status: 200, text: async () => JSON.stringify([{ retries: 0 }]) } as never;
      }
      return { ok: true, status: 200, text: async () => "[]" } as never;
    });
    const res = await publishReady({
      fetchImpl: fetchImpl as never,
      publishImpl: async () => failed("telegram", "chat not found"),
      notifyImpl: async (e) => {
        events.push({ kind: e.kind, severity: e.severity });
        return true;
      },
    });
    expect(res.failures).toHaveLength(1);
    expect(events[0].kind).toBe("publish.failed");
    expect(events[0].severity).toBe("SEV2");
  });

  it("dry-run hiçbir şey yayınlamaz", async () => {
    const publishImpl = vi.fn();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => "[]" }) as never);
    await publishReady({ dryRun: true, fetchImpl: fetchImpl as never, publishImpl: publishImpl as never });
    expect(publishImpl).not.toHaveBeenCalled();
  });

  it("callback işleme onay/atlama sayar", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? "GET"} ${u.split("/rest/v1/")[1]?.split("?")[0]}`);
      if (u.includes("approval_callbacks?processed_at=is.null")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify([
              { id: 1, post_queue_id: 10, action: "approve", payload_json: null },
              { id: 2, post_queue_id: 11, action: "skip", payload_json: null },
            ]),
        } as never;
      }
      return { ok: true, status: 200, text: async () => "[]" } as never;
    });
    const counts = await processCallbacks({ fetchImpl: fetchImpl as never, notifyImpl: async () => true });
    expect(counts.approved).toBe(1);
    expect(counts.skipped).toBe(1);
    expect(calls.some((c) => c.startsWith("PATCH post_queue"))).toBe(true);
  });
});

describe("günlük özet", () => {
  it("marka özetini okunur metne çevirir", () => {
    const text = renderBrandDigest(
      {
        brand: "lifeos",
        published: [
          { brand: "lifeos", platform: "telegram", status: "published", platform_url: "https://t.me/x/1", error_message: null, posted_at: "" },
        ],
        failed: [
          { brand: "lifeos", platform: "tiktok", status: "failed", platform_url: null, error_message: "unaudited_client", posted_at: "" },
        ],
        pendingApproval: 2,
      },
      "2026-08-07",
    );
    expect(text).toContain("1 · ❌ Başarısız: 1");
    expect(text).toContain("Onay bekleyen: 2");
    expect(text).toContain("unaudited_client");
  });

  it("hareketsiz günü yanıltıcı sayı basmadan bildirir", () => {
    const text = renderBrandDigest(
      { brand: "yulalab", published: [], failed: [], pendingApproval: 0 },
      "2026-08-07",
    );
    expect(text).toContain("yayın hareketi yok");
  });
});

import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { ingestMailSignal, type InboundMail } from "./sensors";
import { ingestSentinelEvent } from "./sentinel";

/**
 * Sensör alım ucu — holding'in "gözleri"nin dışarıdan beslenmesi (DEFTER H-023).
 *
 * Neden ayrı bir kimlik doğrulama: besleyiciler KULLANICI değil MAKİNE'dir
 * (launchd işi, CI kancası, harici bir betik). Kullanıcı JWT'si vermek, bir
 * makine anahtarının insan yetkileriyle eşitlenmesi demek olurdu. Bunun yerine
 * tek amaçlı `HOLDING_SENSOR_TOKEN` kullanılır ve SABİT ZAMANLI karşılaştırılır
 * (naif `!==` karşılaştırması yanıt süresinden anahtar sızdırır).
 *
 * Dormant-by-default: token tanımlı değilse veya modül kapalıysa uç YOKTUR
 * (404) — açık ama korumasız bir yüzey bırakmaktansa hiç açılmaması yeğdir.
 *
 * ⚠️ Gelen içerik VERİDİR, TALİMAT DEĞİL: konu/gövde yalnız sınıflandırmaya
 * girer, hiçbir zaman komut olarak yorumlanmaz.
 */
export const sensorRouter = Router();

function tokenOk(given: string | undefined): boolean {
  const expected = process.env.HOLDING_SENSOR_TOKEN ?? "";
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // timingSafeEqual uzunluk farkında FIRLATIR — önce uzunluğu eşitle.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

sensorRouter.post("/event", async (req, res) => {
  if (!env.HOLDING_ENABLED || !process.env.HOLDING_SENSOR_TOKEN) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (!tokenOk(req.header("x-holding-sensor-token") ?? undefined)) {
    logger.warn({ ip: req.ip }, "holding sensor: geçersiz token");
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    // Biçim 1 — ham posta: sınıflandırmayı motor yapar (kural tabanlı, $0).
    if (body.mail) {
      const mail = body.mail as InboundMail;
      if (!mail?.from || typeof mail.subject !== "string") {
        res.status(400).json({ error: "mail: {from, subject} zorunlu" });
        return;
      }
      const r = await ingestMailSignal(mail);
      res.status(201).json({ id: r.id, deduped: r.deduped, signal: r.signal });
      return;
    }

    // Biçim 2 — sınıflandırılmış olay: kaynağın kendisi türü biliyorsa
    // (ör. GitHub Actions API) postayı taklit etmeye gerek yok.
    const { source, kind, severity, venture, payload, salient } = body as Record<string, any>;
    if (!source || !kind || !severity) {
      res.status(400).json({ error: "{source, kind, severity} zorunlu" });
      return;
    }
    const r = await ingestSentinelEvent({
      source: String(source),
      kind: String(kind),
      severity,
      // Harici besleyici ASLA TRUSTED değildir: sinyali kabul ederiz ama
      // güven seviyesini kaynağın iddiasına bırakmayız.
      trustLevel: "UNTRUSTED",
      venture: venture ? String(venture) : undefined,
      payload: (payload ?? {}) as Record<string, unknown>,
      salient: salient ? String(salient) : undefined,
    } as never);
    res.status(201).json({ id: r.id, deduped: r.deduped });
  } catch (err) {
    logger.error({ err }, "holding sensor alımı başarısız");
    res.status(500).json({ error: "ingest failed" });
  }
});

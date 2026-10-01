import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { env } from "../../config/env";
import { prisma } from "../../lib/db";
import { YULA_TENANT_SLUG } from "./tenant";

/**
 * Holding genel bakışı — masaüstü/web arayüzünün "Holding" yüzeyini besler.
 *
 * Neden ayrı bir uç: `/dashboard/*` ÜRÜN dünyasını (şirket, hat, koşu)
 * gösterir; holding'in kendi katmanı (workflow tanımları, onay kuyruğu,
 * sentinel sinyalleri, sensör kalp atışları) orada temsil edilmez. Bunları
 * dashboard'a sıkıştırmak iki farklı yönetişim modelini tek ekranda
 * karıştırırdı.
 *
 * ⚠️ TENANT SINIRI: holding tek bir iç tenant'ta (`yula-internal`) yaşar.
 * Bu uç, çağıran kullanıcı O tenant'a ait DEĞİLSE 403 döner — başka bir
 * tenant'ın kullanıcısı holding verisini görmemeli.
 *
 * ⚠️ DEĞER UYDURMA KURALI (company.ts ile aynı sözleşme): sunucu bilmediği
 * bir şeyi hesaplamaz. "Hiç koşmamış" ile "0 koşu" farklıdır ve ikisi de
 * ayrı alanlarla gönderilir; arayüz bu ayrımı gösterebilsin diye.
 */
export const holdingOverviewRouter = Router();
holdingOverviewRouter.use(authMiddleware);

holdingOverviewRouter.get("/overview", async (req, res, next) => {
  try {
    if (!env.HOLDING_ENABLED) {
      res.status(503).json({ error: "holding dormant", enabled: false });
      return;
    }
    const tenant = await prisma.tenant.findFirst({ where: { slug: YULA_TENANT_SLUG } });
    if (!tenant || req.auth!.tenantId !== tenant.id) {
      res.status(403).json({ error: "holding bu tenant'a açık değil" });
      return;
    }

    const [defs, runsByStatus, pendingApprovals, sentinelByKind, heartbeats, failedSteps, spend] =
      await Promise.all([
        prisma.holdingWorkflowDefinition.findMany({
          select: { id: true, key: true, name: true, riskClass: true, enabled: true },
          orderBy: { key: "asc" },
        }),
        prisma.holdingWorkflowRun.groupBy({ by: ["status"], _count: { _all: true } }),
        prisma.holdingApproval.findMany({
          where: { status: "PENDING" },
          select: { id: true, description: true, riskClass: true, createdAt: true },
          orderBy: { createdAt: "asc" },
          take: 20,
        }),
        prisma.holdingSentinelEvent.groupBy({
          by: ["kind", "severity", "status"],
          _count: { _all: true },
        }),
        prisma.holdingHeartbeat.findMany({
          select: { sensorId: true, lastBeatAt: true, intervalSeconds: true },
        }),
        prisma.holdingStepRun.count({ where: { status: "FAILED" } }),
        prisma.holdingStepRun.aggregate({ _sum: { costUsd: true } }),
      ]);

    // Hangi tanım GERÇEKTEN koşmuş — "etkin" ile "kanıtlanmış" farkı arayüzde
    // görünsün diye ayrı hesaplanır. Etkin ama hiç koşmamış bir workflow,
    // sessizce çalışıyor sanılan en pahalı yanılgıdır.
    const kosanIds = new Set(
      (await prisma.holdingWorkflowRun.findMany({
        distinct: ["definitionId"],
        select: { definitionId: true },
      })).map((r) => r.definitionId),
    );

    // Alt şirketler + kadro + ŞU AN çalışan adımlar.
    const [sirketler, calisanHoldingAdimlari, calisanHatAdimlari] = await Promise.all([
      prisma.company.findMany({
        where: { tenantId: tenant.id },
        select: {
          id: true, name: true, slug: true, status: true,
          _count: { select: { pipelines: true } },
          agents: { select: { id: true, name: true, role: true, model: true } },
        },
        orderBy: { name: "asc" },
      }),
      prisma.holdingStepRun.findMany({
        where: { status: "RUNNING" },
        select: { runId: true, name: true, startedAt: true },
        take: 20,
      }),
      prisma.runStep.findMany({
        where: { status: "RUNNING", run: { pipeline: { company: { tenantId: tenant.id } } } },
        select: {
          runId: true, name: true, startedAt: true, agentId: true,
          agent: { select: { name: true, role: true, model: true } },
        },
        take: 20,
      }),
    ]);
    // Hangi ajanlar şu an bir adımda — arayüzde nokta yakılacak küme.
    const calisanAjanIds = new Set(calisanHatAdimlari.map((s) => s.agentId).filter(Boolean) as string[]);

    const sonKosular = await prisma.holdingWorkflowRun.findMany({
      select: {
        id: true, status: true, venture: true, createdAt: true, finishedAt: true,
        definition: { select: { key: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 15,
    });

    const now = Date.now();
    res.json({
      enabled: true,
      workflows: {
        toplam: defs.length,
        etkin: defs.filter((d) => d.enabled).length,
        kosmus: defs.filter((d) => kosanIds.has(d.id)).length,
        // Etkin ama hiç koşmamışlar — arayüz bunları ayrıca uyarı olarak gösterir.
        etkinAmaKosmamis: defs
          .filter((d) => d.enabled && !kosanIds.has(d.id))
          .map((d) => ({ key: d.key, name: d.name, riskClass: d.riskClass })),
        liste: defs.map((d) => ({
          key: d.key, name: d.name, riskClass: d.riskClass,
          enabled: d.enabled, kosmus: kosanIds.has(d.id),
        })),
      },
      kosular: {
        durumlar: Object.fromEntries(runsByStatus.map((r) => [r.status, r._count._all])),
        basarisizAdim: failedSteps,
        toplamHarcamaUsd: Number(spend._sum.costUsd ?? 0),
        son: sonKosular.map((r) => ({
          id: r.id, key: r.definition.key, ad: r.definition.name,
          durum: r.status, venture: r.venture,
          basladi: r.createdAt, bitti: r.finishedAt,
        })),
      },
      onaylar: pendingApprovals.map((a) => ({
        id: a.id, aciklama: a.description, riskClass: a.riskClass, olusturuldu: a.createdAt,
      })),
      sinyaller: {
        toplam: sentinelByKind.reduce((n, s) => n + s._count._all, 0),
        islenmemis: sentinelByKind.filter((s) => s.status === "NEW").reduce((n, s) => n + s._count._all, 0),
        gruplar: sentinelByKind.map((s) => ({
          kind: s.kind, severity: s.severity, status: s.status, adet: s._count._all,
        })),
      },
      sensorler: heartbeats.map((h) => {
        const yas = (now - h.lastBeatAt.getTime()) / 1000;
        return {
          id: h.sensorId,
          sonAtis: h.lastBeatAt,
          aralikSn: h.intervalSeconds,
          // Ölü-adam kuralı: iki aralık geçtiyse sensör bayat sayılır.
          bayat: yas > h.intervalSeconds * 2,
        };
      }),
      // Alt şirketler + kadroları. Holding yüzeyi "şirket" sekmesinin yerini
      // aldığı için bu veri artık ayrı bir uçtan değil buradan gelir —
      // kullanıcı tek istekte holding + iştirakler + ajanlar görür.
      sirketler: sirketler.map((c) => ({
        id: c.id,
        ad: c.name,
        slug: c.slug,
        durum: c.status,
        hatSayisi: c._count.pipelines,
        ajanlar: c.agents.map((a) => ({
          id: a.id, ad: a.name, rol: a.role, model: a.model,
          // Bu ajan ŞU AN bir adımda mı — arayüz "kim çalışıyor"u gösterebilsin.
          calisiyor: calisanAjanIds.has(a.id),
        })),
      })),
      // Şu an koşan iş: hem holding adımı hem ürün hattı adımı. İkisi ayrı
      // raporlanır — biri yönetişim, diğeri üretim; karıştırmak "ne oluyor"
      // sorusunu bulanıklaştırır.
      calisan: {
        holdingAdimlari: calisanHoldingAdimlari.map((s) => ({
          run: s.runId, ad: s.name, baslangic: s.startedAt,
        })),
        hatAdimlari: calisanHatAdimlari.map((s) => ({
          run: s.runId, ad: s.name, ajanId: s.agentId,
          ajan: s.agent ? { ad: s.agent.name, rol: s.agent.role, model: s.agent.model } : null,
          baslangic: s.startedAt,
        })),
      },
      // Kadro henüz çalışma-zamanına girmedi (DEFTER H-025). Alan bilerek
      // burada duruyor: arayüz "yok" diyebilsin, sıfır sanmasın.
      kadro: {
        runtimeAjan: sirketler.reduce((n, c) => n + c.agents.length, 0),
        runbookVar: true,
      },
    });
  } catch (err) {
    next(err);
  }
});

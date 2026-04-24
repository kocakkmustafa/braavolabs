---
description: Her sabah çalıştırılacak günlük briefing — metrics, öncelikler, içerik önerileri
---

> **PROJE BAĞLAMI**: Bu komut Braavolabs (braavolabs.com) üzerinde çalışır. Komutun içindeki "The Creator", "Pipeline Builder", "thecreator.app" gibi referanslar **Braavolabs karşılıklarına** çevrilir. Tam harita: `.claude/PROJE-BAGLAM.md`.
>
> **4 çıktı hedefi** (Braavolabs için):
> - `docs/roadmap/launch-roadmap.md` — V1 launch / ilk 1000 user plan (Faz 18 SONRASI, go-live odak)
> - `docs/daily/daily-checklist.md` — günlük operasyon
> - `docs/marketing/marketing-plan.md` — go-to-market (agent-in-a-box kategorisi, Zapier değil)
> - `docs/manual-tasks.md` — Mustafa'nın elle yapacakları

---


# /daily-briefing

Canlıya çıktıktan sonra her sabah çalıştır. Gün için netlik sağlar.

## Ne Zaman?

- Her sabah 08:00-10:00 arası
- Derin iş başlamadan önce
- Coffee + nargile ile birlikte

## İşlem

### 1. Veri Topla (mümkün olan her kaynaktan)

```bash
# Stripe (MCP server varsa)
# - Dün kaç ödeme?
# - MRR durumu
# - Failed payments

# PostHog / Analytics
# - Dün kaç unique visitor?
# - Signup sayısı?
# - Activation rate?
# - Top pages?

# Sentry
# - Yeni error?
# - Error rate değişti mi?

# Vercel
# - Uptime
# - Build status

# Supabase
# - Database load
# - Execution queue backlog

# GitHub
# - Son commitler
# - Açık PR
# - Yeni issue
```

### 2. Roadmap Kontrol

Aktif faz neresi? Bugünkü öncelik ne?

### 3. İçerik Fırsatları

- Dün sosyal medyada neden bahsedildi?
- Rakip yeni feature çıkardı mı? (Tavily search)
- Trend AI topic'leri?
- Blog post bugün hangisi yayınlanacak?

## Çıktı Formatı

```markdown
# 🌅 GÜNAYDIN MUSTAFA — {TARİH}

## 📊 DÜN OLAN BİTEN

### Metrics
- 👤 Yeni signup: {X} (dün: {Y}, hafta ort: {Z})
- ✅ Activation: {X} ({rate}% — dün: {Y}%)
- 💰 Yeni paying: {X} (dün: {Y})
- 💸 MRR: ${X} ({değişim})
- 😢 Churn: {X}
- 🎯 Ads spend / ROAS: ${X} / {Y}x

### Sistem
- Uptime: {X}%
- Hata: {X} (Sentry)
- Execution başarı: {X}%

### İçerik
- Blog traffic: {X} (new: "{blog başlığı}")
- YouTube views: {X}
- Twitter engagement: {X}

## 🎯 BUGÜNKÜ 3 ÖNCELİK

1. **{Görev 1}** — {tahmini süre, neden kritik}
2. **{Görev 2}** — {...}
3. **{Görev 3}** — {...}

## ⚠️ DİKKAT GEREKTİREN

- {Eğer varsa: ödeme problemi, error spike, negative feedback}

## 💡 BUGÜN İÇİN İÇERİK ÖNERİSİ

### Tweet (sabah kahvesi ile)
> "{Önerilen tweet içeriği}"

### LinkedIn (öğleden sonra)
> "{Önerilen LinkedIn post taslağı}"

### Blog post (eğer planlandıysa)
- "{Başlık}" — content brief: `.claude/context/content/blog-brief-XX.md`
- Yayınlama: 14:00 EST (en iyi saat)

## 📅 BUGÜNKÜ TAKVİM

### Sprint görevi
- {Roadmap'ten aktif görev}

### Support
- {Açık ticket sayısı, kritik olanlar}

### Kullanıcı görüşmeleri
- {Zoom schedule'da neler var}

## 📈 HAFTALIK HEDEFLERE İLERLEME

- [ ] Yeni signup: {X}/{hedef} ({X}%)
- [ ] Yeni blog post: {X}/{hedef}
- [ ] YouTube video: {X}/{hedef}
- [ ] Sprint story: {X}/{hedef}

## 🎨 İÇERİK KALENDERİ

- **Bugün**: {ne yayınlanacak}
- **Yarın**: {ne planlanıyor}
- **Bu hafta sonu**: {weekend içerik}

## 🎯 METRIC SPOTLIGHT

Bu hafta odaklanılan metrik: **{Metrik adı}**
Şu an: {değer}
Hafta hedefi: {değer}
Delta: {+/- %}

En çok etkileyen şey: {Aksiyon önerisi}

## 🔔 REMINDER

- **Bu Cuma**: Newsletter send (09:00 EST)
- **Bu Cumartesi**: Weekly review + strategy session
- **Bu Pazartesi**: /run-agent user (UX re-test)
- **Bu ayın 1'i**: /next-cycle tam denetim

## 💬 SON KULLANICI MESAJLARI

(Eğer varsa, Gmail MCP / Crisp'ten ilk 3 mesaj)

## 🏁 GÜNÜN KAPANIŞ KONTROLÜ

Bu akşam 22:00'da şunları kontrol et:
- [ ] Bugünkü 3 öncelik tamamlandı mı?
- [ ] Yarın için 3 yeni öncelik yazıldı mı?
- [ ] Metric snapshot alındı mı?
- [ ] Community engagement (Discord + X)?

---

🚀 **Good morning, let's ship!**

```

## Özel Durumlar

### Launch günü
```
🎉 LAUNCH DAY!

Öncelik:
1. Product Hunt'ı 00:01 PT'de submit et
2. Hacker News Show HN 08:00 ET
3. Twitter mega-thread 10:00 ET
4. Newsletter send 10:30 ET
5. Discord announcement 12:00 ET
6. Her saat: Metrics snapshot + comment engagement

Kritik:
- PH sıralamasını takip et
- Ads canlı mı kontrol et
- Site down olursa: Vercel rollback hazır
```

### Beta hafta
```
📋 Beta Week Day {X}/7

Öncelik:
1. Beta user'lara 1:1 check-in (5 kişi / gün)
2. Bug triyaj (yeni gelen)
3. Feature request priorization
4. İlk testimonial toplama
```

### Normal gün
Yukarıdaki standart format.

## Otomasyon Önerisi

Cron ile 08:00'da otomatik çalıştır:
```bash
# Mustafa'nın Mac'inde / Linux server'da:
0 8 * * * cd /path/to/the-creator && claude code --headless --command "/daily-briefing" > /tmp/briefing-$(date +\%Y\%m\%d).md
```

Sonra Mustafa kahvesini alıp açsın, günün başlamış.

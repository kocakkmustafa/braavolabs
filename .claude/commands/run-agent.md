---
description: Tek bir ajanı çalıştır (hacker, user, dev-agent, qa-agent, marketing-agent, ads-agent, seo-agent, ux-agent, content-agent, orchestrator)
argument-hint: <ajan-adı>
---

> **PROJE BAĞLAMI**: Bu komut Braavolabs (braavolabs.com) üzerinde çalışır. Komutun içindeki "The Creator", "Pipeline Builder", "thecreator.app" gibi referanslar **Braavolabs karşılıklarına** çevrilir. Tam harita: `.claude/PROJE-BAGLAM.md`.
>
> **4 çıktı hedefi** (Braavolabs için):
> - `docs/roadmap/launch-roadmap.md` — V1 launch / ilk 1000 user plan (Faz 18 SONRASI, go-live odak)
> - `docs/daily/daily-checklist.md` — günlük operasyon
> - `docs/marketing/marketing-plan.md` — go-to-market (agent-in-a-box kategorisi, Zapier değil)
> - `docs/manual-tasks.md` — Mustafa'nın elle yapacakları

---


# /run-agent <ajan-adı>

Tek bir ajanı bağımsız çalıştır. Tam cycle'a gerek yoksa veya belirli bir alanda derinleşmek istiyorsan kullan.

## Kullanım

```
/run-agent hacker
/run-agent user
/run-agent dev-agent
/run-agent qa-agent
/run-agent marketing-agent
/run-agent ads-agent
/run-agent seo-agent
/run-agent ux-agent
/run-agent content-agent
/run-agent orchestrator
```

## Her Ajan Ne Zaman Çalıştırılmalı?

### `hacker`
- Yeni feature ekledin mi? (auth, payment, API endpoint)
- Güvenlik concern'ün mü var?
- Pen test süresi mi geldi?
- **Önerilen sıklık**: 2 haftada bir, her launch öncesi

### `user`
- UX değişikliği yaptın mı?
- Onboarding flow değiştiyse?
- Dönüşüm düştü mü?
- **Önerilen sıklık**: Her major UX değişikliği sonrası, aylık

### `dev-agent`
- Kod kalitesi kontrol mü?
- Teknik borç değerlendirme mi?
- Performance problem mi?
- **Önerilen sıklık**: Haftalık, büyük PR sonrası

### `qa-agent`
- Ödeme entegrasyonu güncellendi mi?
- Yeni quota limit eklendi mi?
- Webhook değişti mi?
- **Önerilen sıklık**: Her ödeme/billing değişikliği sonrası

### `marketing-agent`
- Pozisyonlama değişti mi?
- Yeni segment mi hedefliyorsun?
- Pricing değişti mi?
- **Önerilen sıklık**: Aylık, stratejik değişim sonrası

### `ads-agent`
- Yeni kampanya mı başlatıyorsun?
- Mevcut kampanya ROAS düşük mü?
- Yeni platform ekledin mi?
- **Önerilen sıklık**: Haftalık (launch sonrası), sonra aylık

### `seo-agent`
- Yeni içerik yayınladın mı?
- Google Core Update mi geldi?
- Rakip yeni ürün çıkardı mı?
- **Önerilen sıklık**: Aylık

### `ux-agent`
- Activation düştü mü?
- Kullanıcı feedback'te UX şikayeti mi?
- Yeni feature UX incelemesi mi?
- **Önerilen sıklık**: Her büyük UX değişikliği

### `content-agent`
- Aylık içerik planı mı?
- Yeni blog post brief mi?
- Newsletter temi mı?
- **Önerilen sıklık**: Haftalık (içerik üretimi devam ederken)

### `orchestrator`
- Tüm raporları re-process mu?
- Yeni bir öncelik kararı mı?
- Roadmap güncelleme mi?
- **Önerilen sıklık**: Her `/run-full-audit` sonrası

## Çıktılar

Ajan raporu: `.claude/context/reports/{ajan-adi}-{tarih}.md`

Eğer orchestrator'ı çağırıyorsan: Son merged çıktılar güncellenir.

## Örnek Kullanım

```
/run-agent hacker
```

Çıktı:
```
🛡 Hacker agent çalıştırılıyor...
- Repo God security skill'leri taranıyor...
- OWASP Top 10 audit başlatıldı...
- SaaS özel saldırı vektörleri kontrol ediliyor...
- Pipeline execution güvenliği analiz ediliyor...
- Multi-tenant isolation test ediliyor...

✅ Rapor hazır: .claude/context/reports/hacker-2026-04-20.md

Özet:
- 3 kritik bulgu
- 7 yüksek risk
- 4 orta risk
- 2 düşük risk

Orchestrator'ı çağır mı? (/run-agent orchestrator)
```

## Dikkat

- Tek ajan çalıştırmak → orchestrator çalışmaz → kod değişikliği yapılmaz
- Orchestrator çağrılırsa tüm mevcut raporları okur ve uygular
- İstediğin ajanı çalıştır, sonra orchestrator'ı çağır (2 adımlı workflow)

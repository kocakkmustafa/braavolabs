---
description: Tüm ajanları sırasıyla çalıştır ve orchestrator ile merkezi rapor + 4 çıktı üret
---

> **PROJE BAĞLAMI**: Bu komut Braavolabs (braavolabs.com) üzerinde çalışır. Komutun içindeki "The Creator", "Pipeline Builder", "thecreator.app" gibi referanslar **Braavolabs karşılıklarına** çevrilir. Tam harita: `.claude/PROJE-BAGLAM.md`.
>
> **4 çıktı hedefi** (Braavolabs için):
> - `docs/roadmap/launch-roadmap.md` — V1 launch / ilk 1000 user plan (Faz 18 SONRASI, go-live odak)
> - `docs/daily/daily-checklist.md` — günlük operasyon
> - `docs/marketing/marketing-plan.md` — go-to-market (agent-in-a-box kategorisi, Zapier değil)
> - `docs/manual-tasks.md` — Mustafa'nın elle yapacakları

---


# /run-full-audit

The Creator projesi için tam denetim döngüsü başlatır. Tüm 9 ajan sırayla çalışır, sonra orchestrator raporları sentezler ve 4 ana çıktıyı üretir.

## Çalışma Sırası

1. **Orchestrator**: Repo God discovery (ilk görev)
2. **Hacker**: Güvenlik denetimi (OWASP + SaaS özel)
3. **User**: 5 persona ile kullanıcı testi
4. **Dev-agent**: Kod kalitesi ve mimari
5. **QA-agent**: Ödeme akışı, quota, edge case
6. **Marketing-agent**: Pozisyonlama ve strateji
7. **Ads-agent**: Reklam kampanya planı
8. **SEO-agent**: Teknik + içerik SEO
9. **UX-agent**: Onboarding ve deneyim
10. **Content-agent**: İçerik stratejisi
11. **Orchestrator (final)**: Senteze, çakışma çözümü, kod uygulaması

## Tahmini Süre

İlk cycle: 45-75 dakika
Sonraki cycle'lar: 25-40 dakika (incremental)

## Ön Koşullar

```bash
# Git repo olmalı
git status || (echo "❌ Git repo yok, git init çalıştır"; exit 1)

# Uncommitted değişiklikleri kaydet
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "snapshot before /run-full-audit"
fi

# Context dizini hazır olsun
mkdir -p .claude/context/reports
mkdir -p docs/roadmap docs/daily docs/marketing docs/technical
```

## İşlem Akışı

### Adım 1: Repo God Discovery

Orchestrator ajanını çağır, sadece Repo God keşfi yap:
- `.claude/context/repo-god-inventory.md` oluştur
- Hangi varlıklar var, hangileri bu projede kullanılacak

### Adım 2: Tüm Ajanları Çalıştır (Sıralı)

Her ajan için:
```
@{ajan-adi} 
Lütfen The Creator projesi için tam bir denetim yap.
Bulgularını .claude/context/reports/{ajan-adi}-{tarih}.md dosyasına yaz.
Repo God envanterine bak ve ilgili varlıkları kullan.
```

Sıra:
1. hacker
2. user
3. dev-agent
4. qa-agent
5. marketing-agent
6. ads-agent
7. seo-agent
8. ux-agent
9. content-agent

### Adım 3: Orchestrator Final Pass

```
@orchestrator
Tüm ajanların raporlarını oku.
Master issue list oluştur.
Çakışmaları çöz.
P1 (kritik) issue'ları otomatik uygula (git commit per fix).
4 ana çıktıyı üret:
- docs/roadmap/launch-roadmap.md
- docs/daily/daily-checklist.md
- docs/marketing/marketing-plan.md
- docs/manual-tasks.md
```

### Adım 4: Son Özet

Orchestrator'ın Mustafa'ya yazacağı özet:
- Kaç issue bulundu
- Kaçı otomatik çözüldü
- Kaçı Mustafa'nın eline kaldı
- Sonraki 3 kritik adım
- Ne zaman `/next-cycle` çalıştırsın

## Kullanıcı Deneyimi

Komut çalışırken Mustafa:
- Her ajanın ne yaptığını görebilir (real-time)
- İstediği zaman Ctrl+C ile durdurabilir
- Çıktıları arka planda takip edebilir (`.claude/context/reports/` dizinini izle)

## Sonrası

Orchestrator son raporunu sunar. Mustafa:
1. `docs/manual-tasks.md` → kendi eliyle yapacaklarını gör
2. `docs/roadmap/launch-roadmap.md` → canlıya çıkış yol haritasını gör
3. Git log'a bak → otomatik uygulanan fix'leri gör
4. `/status` ile durumu kontrol et

## İlk Çalıştırmadan Sonra

Eğer ilk cycle'sa, Mustafa manuel task'lardan en az 5'ini halletmeli. Sonra ~1 hafta sonra `/next-cycle`.

## Hatalar ve Toparlanma

- Bir ajan başarısız olursa diğerleri devam eder
- Orchestrator eksik raporlu olsa bile toplanmış olanlarla çalışır
- Kod değişikliği başarısız olursa git reset ile geri al
- Her P1 commit ayrı olduğu için selective revert mümkün

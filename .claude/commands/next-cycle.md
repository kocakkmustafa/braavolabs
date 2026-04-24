---
description: Bir sonraki cycle'ı başlat — mevcut raporları arşivle, yeni audit yap
---

> **PROJE BAĞLAMI**: Bu komut Braavolabs (braavolabs.com) üzerinde çalışır. Komutun içindeki "The Creator", "Pipeline Builder", "thecreator.app" gibi referanslar **Braavolabs karşılıklarına** çevrilir. Tam harita: `.claude/PROJE-BAGLAM.md`.
>
> **4 çıktı hedefi** (Braavolabs için):
> - `docs/roadmap/launch-roadmap.md` — V1 launch / ilk 1000 user plan (Faz 18 SONRASI, go-live odak)
> - `docs/daily/daily-checklist.md` — günlük operasyon
> - `docs/marketing/marketing-plan.md` — go-to-market (agent-in-a-box kategorisi, Zapier değil)
> - `docs/manual-tasks.md` — Mustafa'nın elle yapacakları

---


# /next-cycle

Yeni bir denetim döngüsü başlat. Mevcut raporlar arşivlenir, master issue list'ten eski cycle etiketi gelir, her şey sıfırlanır ve `/run-full-audit` çalıştırılır.

## Ne Zaman Kullanılmalı?

- **İlk cycle'dan 1-2 hafta sonra**: Blokerleri kapattıysan
- **Her büyük milestone sonrası**: Beta launch, public launch
- **Ayda bir**: Rutin ritim olarak
- **Production'a deploy sonrası**: Yeni rapor üretmek için

## İşlem

### 1. Önceki Cycle'ı Arşivle

```bash
PREV_CYCLE=$(ls .claude/context/reports/ | head -1 | cut -d'-' -f2-4)
mkdir -p .claude/context/archive/cycle-$PREV_CYCLE
mv .claude/context/reports/*.md .claude/context/archive/cycle-$PREV_CYCLE/ 2>/dev/null
mv .claude/context/master-issues.json .claude/context/archive/cycle-$PREV_CYCLE/ 2>/dev/null
```

### 2. Önceki Çıktıları Yedekle

```bash
mkdir -p docs/archive/cycle-$PREV_CYCLE
cp docs/roadmap/launch-roadmap.md docs/archive/cycle-$PREV_CYCLE/
cp docs/daily/daily-checklist.md docs/archive/cycle-$PREV_CYCLE/
cp docs/marketing/marketing-plan.md docs/archive/cycle-$PREV_CYCLE/
cp docs/manual-tasks.md docs/archive/cycle-$PREV_CYCLE/
```

### 3. Commit

```bash
git add -A
git commit -m "archive cycle $PREV_CYCLE, start new cycle"
```

### 4. `/run-full-audit` Çağır

Tüm ajanlar yeniden çalışır, bu sefer mevcut durumu baz alarak. Önemli: **ajanlar önceki raporu okuyabilir** (arşivden), ilerlemeyi kıyaslayabilir.

## Yeni Cycle'da Farklı Olan

### Ajanlar Önceki Raporu Bilir

Orchestrator, yeni cycle başlarken her ajana önceki raporunu bilgi olarak iletir:
- "Önceki cycle'da bulduğun 12 issue'dan 8'i çözüldü ✓"
- "4 tanesi hala açık — detaylı kontrol et"
- "3 yeni alan incele: webhook signing, PPP pricing, team invite"

### Progress Tracking

```markdown
# CYCLE 2 PROGRESS

Önceki cycle sonuçları:
- 147 issue bulundu
- 42 otomatik uygulandı (orchestrator)
- 23 manuel task Mustafa'ya devredildi
- 18 manuel task tamamlandı ✓
- 5 manuel task hala açık

Bu cycle yeni bulgular:
- X yeni issue
- Y önceki açık issue'nun durumu değişmiş

Progress: %78 launch readiness (önceki: %45)
```

### Metrik Karşılaştırma

Orchestrator raporuna metric comparison ekler:

| Metrik | Cycle 1 | Cycle 2 | Δ |
|--------|---------|---------|---|
| Güvenlik skoru | 5/10 | 8/10 | +3 ✓ |
| UX skoru | 4/10 | 7/10 | +3 ✓ |
| SEO skoru | 2/10 | 6/10 | +4 ✓ |
| Activation rate | - | %35 | baseline |
| Free→Paid | - | %4 | baseline |

## Cycle'lar Arası Ne Yapmalı?

### İlk cycle sonrası
- Hukuki (ToS, Privacy)
- Altyapı (domain, Stripe, Supabase)
- Kritik güvenlik fix doğrulama

### İkinci cycle sonrası
- Beta kullanıcı feedback'i
- Core UX iyileştirmeleri
- İlk 5 blog post

### Üçüncü cycle sonrası
- Launch hazırlık (PH, HN, X)
- Ads kampanya creative
- Email sequence

## Örnek Kullanım

```
/next-cycle
```

Çıktı:
```
📦 Önceki cycle arşivlendi: cycle-2026-04-06
🗂 15 rapor archive/'a taşındı
📝 4 output doc yedeklendi
💾 Git commit: "archive cycle 2026-04-06, start new cycle"

🚀 Yeni cycle başlatılıyor...
🔍 Repo God tekrar keşif yapılıyor (güncellenmiş varlıklar için)...

@orchestrator
@hacker
@user
@dev-agent
...

(normal /run-full-audit akışı)
```

## Sıklık Önerisi

- **Launch öncesi**: Haftalık
- **Launch sonrası ilk 30 gün**: Haftalık
- **Stabilize olduktan sonra**: 2 haftada bir
- **Mature product**: Aylık

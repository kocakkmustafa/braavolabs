---
description: Projenin mevcut durumunu, kaç cycle çalışmış, kaç issue açık, faz durumu ve metric karşılaştırmayı göster
---

> **PROJE BAĞLAMI**: Bu komut Braavolabs (braavolabs.com) üzerinde çalışır. Komutun içindeki "The Creator", "Pipeline Builder", "thecreator.app" gibi referanslar **Braavolabs karşılıklarına** çevrilir. Tam harita: `.claude/PROJE-BAGLAM.md`.
>
> **4 çıktı hedefi** (Braavolabs için):
> - `docs/roadmap/launch-roadmap.md` — V1 launch / ilk 1000 user plan (Faz 18 SONRASI, go-live odak)
> - `docs/daily/daily-checklist.md` — günlük operasyon
> - `docs/marketing/marketing-plan.md` — go-to-market (agent-in-a-box kategorisi, Zapier değil)
> - `docs/manual-tasks.md` — Mustafa'nın elle yapacakları

---


# /status

The Creator'ın mevcut durumunu tek bakışta sunar. Hızlı sağlık kontrolü için.

## İşlem

### 1. Veri Topla

```bash
# Cycle sayısı
CYCLES=$(ls -1 .claude/context/archive/ 2>/dev/null | wc -l)
CYCLES=$((CYCLES + 1))  # mevcut cycle dahil

# Issue sayıları
if [ -f .claude/context/master-issues.json ]; then
  TOTAL=$(jq '.total_issues' .claude/context/master-issues.json)
  PENDING=$(jq '[.issues[] | select(.status == "pending")] | length' .claude/context/master-issues.json)
  APPLIED=$(jq '[.issues[] | select(.status == "applied")] | length' .claude/context/master-issues.json)
  MANUAL=$(jq '[.issues[] | select(.assigned_to == "mustafa")] | length' .claude/context/master-issues.json)
fi

# Repo God
if [ -f .claude/context/repo-god-inventory.md ]; then
  REPO_GOD_STATUS="✓ keşfedildi"
  REPO_GOD_PATH=$(grep "Konum:" .claude/context/repo-god-inventory.md | head -1)
else
  REPO_GOD_STATUS="✗ henüz keşfedilmedi"
  REPO_GOD_PATH=""
fi

# Son ajan raporları
LATEST_REPORTS=$(ls -1t .claude/context/reports/ 2>/dev/null | head -9)

# Git son commit
LAST_COMMIT=$(git log -1 --format="%h %s (%ar)")

# Launch readiness tahmini
# ... (orchestrator'dan hesap)
```

### 2. Çıktı Formatı

```markdown
# 📊 THE CREATOR — PROJECT STATUS

**Rapor tarihi**: {YYYY-MM-DD HH:MM}

## 🎯 GENEL DURUM

- **Aktif cycle**: #{N}
- **Launch readiness**: %{X}
- **Günlerdir çalışıyor**: {N}
- **Son cycle**: {tarih}
- **Son commit**: {hash} - {message}

## 🔥 REPO GOD ENTEGRASYON

- **Durum**: {✓ keşfedildi / ✗ henüz bulunamadı}
- **Konum**: {path}
- **Kullanılan varlık sayısı**: {N}
- **Kopyalanan**: {N}

## 📋 ISSUE DURUMU

```
Toplam: {X}
├─ ✅ Uygulandı: {X}
├─ ⏳ Beklemede: {X}
├─ 👤 Mustafa'da: {X}
└─ ❌ Bloke: {X}

Öncelik bazında:
├─ P1 (Kritik): {X} → {X} çözüldü
├─ P2 (Yüksek): {X} → {X} çözüldü
├─ P3 (Orta): {X}
└─ P4 (Düşük): {X}
```

## 🚀 LAUNCH ROADMAP DURUMU

- [x] Faz 0: Kritik Blokerler ({X}/{Y} tamamlandı)
- [ ] Faz 1: MVP Hazırlık ({X}/{Y} tamamlandı)
- [ ] Faz 2: Private Beta
- [ ] Faz 3: Public Launch
- [ ] Faz 4: Growth

**Aktif faz**: {Faz adı}
**Faz ilerleme**: %{X}
**Tahmini kalan süre**: {X} gün

## 📝 SON AJAN RAPORLARI

| Ajan | Son Rapor | Durum |
|------|-----------|-------|
| hacker | 2026-04-20 | 3 kritik bulgu |
| user | 2026-04-20 | %35 activation tahmini |
| dev-agent | 2026-04-20 | 7 refactor önerisi |
| qa-agent | 2026-04-20 | 5 edge case |
| marketing-agent | 2026-04-20 | Pozisyonlama onaylı |
| ads-agent | 2026-04-20 | 90 gün plan hazır |
| seo-agent | 2026-04-20 | 30 keyword targeted |
| ux-agent | 2026-04-20 | Onboarding revizyonu |
| content-agent | 2026-04-20 | 30 blog brief hazır |

## 👤 MUSTAFA'NIN AÇIK MANUEL GÖREVLERİ ({X})

### 🚨 Yüksek öncelik
- [ ] Domain satın al (thecreator.app)
- [ ] Stripe prod aktivasyonu
- [ ] ToS + Privacy Policy

### 🟡 Orta öncelik
- [ ] Logo design
- [ ] Discord server aç
- [ ] Sosyal medya hesapları

## 🎯 BU HAFTA ÖNCELİKLERİ

1. {En kritik görev}
2. {İkinci}
3. {Üçüncü}

## 📈 CYCLE İLERLEME

```
Cycle 1 (2026-04-06): 147 issue bulundu, 42 çözüldü
Cycle 2 (2026-04-13): 89 issue, 35 çözüldü, %70 launch readiness
Cycle 3 (2026-04-20): 52 issue, 28 çözüldü, %82 launch readiness ← AKTİF
```

## 🚦 SAĞLIK SKORU

- Güvenlik: 8/10 🟢
- Kod kalitesi: 7/10 🟢
- UX: 6/10 🟡
- SEO: 5/10 🟡
- Content: 4/10 🔴
- Marketing: 6/10 🟡
- **Genel**: 6/10 🟡

## 🔮 SONRAKİ AKSİYONLAR

### Şu an yapılabilir
- `/run-agent user` — UX değişikliği sonrası re-test
- `/run-agent seo-agent` — blog yayınından sonra SEO re-check

### 1-2 hafta sonra
- `/next-cycle` — tam denetim (beta launch öncesi)

### Önümüzdeki ay
- Product Hunt launch hazırlık
- İlk affiliate ortaklıklar
- Case study yazımı
```

## Özel Durumlar

### İlk çalıştırmada
Eğer hiç cycle yapılmamışsa:
```
⚠️ Henüz hiç cycle çalışmamış.

Başlamak için:
  /run-full-audit

Bu komut ~45-75 dakika sürer ve 4 çıktı üretir:
- docs/roadmap/launch-roadmap.md
- docs/daily/daily-checklist.md
- docs/marketing/marketing-plan.md
- docs/manual-tasks.md
```

### Stale data
Son cycle 14+ gün öncesi ise:
```
⚠️ Son cycle 18 gün önce. Güncellemek için:
  /next-cycle
```

### Launch ready
Launch readiness %95+ ise:
```
🎉 Launch için hazırsın!

Son kontroller:
- [ ] Domain DNS propagation
- [ ] Stripe prod webhook
- [ ] Sentry monitoring
- [ ] Product Hunt submission

Launch day komutu: /run-full-audit (son audit) + deploy
```

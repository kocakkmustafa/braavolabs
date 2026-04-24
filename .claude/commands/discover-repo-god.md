---
description: The Repo God varlıklarını (ajanlar, skills, hooks, commands) keşfet ve envanter oluştur
---

> **PROJE BAĞLAMI**: Bu komut Braavolabs (braavolabs.com) üzerinde çalışır. Komutun içindeki "The Creator", "Pipeline Builder", "thecreator.app" gibi referanslar **Braavolabs karşılıklarına** çevrilir. Tam harita: `.claude/PROJE-BAGLAM.md`.
>
> **4 çıktı hedefi** (Braavolabs için):
> - `docs/roadmap/launch-roadmap.md` — V1 launch / ilk 1000 user plan (Faz 18 SONRASI, go-live odak)
> - `docs/daily/daily-checklist.md` — günlük operasyon
> - `docs/marketing/marketing-plan.md` — go-to-market (agent-in-a-box kategorisi, Zapier değil)
> - `docs/manual-tasks.md` — Mustafa'nın elle yapacakları

---


# /discover-repo-god

Mustafa'nın "the-repo-god" dosyasındaki tüm Claude Code varlıklarını keşfeder, kataloglar ve The Creator projesi için nasıl kullanılacağını belirler.

## Ne Zaman Kullanılır?

- **İlk kurulum**: Proje baştan kuruluyorsa
- **Repo God güncellemesi sonrası**: Mustafa yeni ajan/skill eklediğinde
- **Yeni ihtiyaç çıkınca**: "Bu işi daha iyi yapan bir ajan var mı?"
- **`/run-full-audit`'in bir parçası olarak** (orchestrator otomatik yapar ama manuel de çağrılabilir)

## İşlem

### Adım 1: Repo God'u Bul

```bash
REPO_GOD_PATH=""

# Muhtemel lokasyonlar
CANDIDATES=(
  "$HOME/the-repo-god"
  "$HOME/the_repo_god"
  "$HOME/projects/the-repo-god"
  "$HOME/Documents/the-repo-god"
  "$HOME/Code/the-repo-god"
  "$HOME/Workspace/the-repo-god"
  "$HOME/Desktop/the-repo-god"
  "/opt/the-repo-god"
)

for path in "${CANDIDATES[@]}"; do
  if [ -d "$path" ]; then
    REPO_GOD_PATH="$path"
    echo "✓ Repo God bulundu: $path"
    break
  fi
done

# Bulunamadıysa genel arama
if [ -z "$REPO_GOD_PATH" ]; then
  echo "🔍 Ev dizininde daha derin arama..."
  REPO_GOD_PATH=$(find "$HOME" -maxdepth 5 -type d \( -iname "*repo*god*" \) 2>/dev/null | head -1)
fi

if [ -z "$REPO_GOD_PATH" ]; then
  echo "❌ Repo God bulunamadı"
  echo ""
  echo "Lütfen Mustafa'ya sor:"
  echo "  'the-repo-god dosyanın tam yolu ne?'"
  echo ""
  echo "Sonra tekrar çalıştır:"
  echo "  /discover-repo-god <path>"
  exit 1
fi
```

### Adım 2: Yapıyı İncele

```bash
echo "=== REPO GOD YAPISI ==="
tree "$REPO_GOD_PATH" -L 3 --charset=ascii 2>/dev/null || find "$REPO_GOD_PATH" -maxdepth 3 -type d

echo ""
echo "=== AJANLAR ==="
ls -la "$REPO_GOD_PATH/.claude/agents/" 2>/dev/null

echo ""
echo "=== SKILLS ==="
ls -la "$REPO_GOD_PATH/.claude/skills/" 2>/dev/null
ls -la "$REPO_GOD_PATH/skills/" 2>/dev/null

echo ""
echo "=== HOOKS ==="
ls -la "$REPO_GOD_PATH/.claude/hooks/" 2>/dev/null

echo ""
echo "=== COMMANDS ==="
ls -la "$REPO_GOD_PATH/.claude/commands/" 2>/dev/null

echo ""
echo "=== ROOT DOSYALAR ==="
ls -la "$REPO_GOD_PATH/" | head -30
```

### Adım 3: Her Varlığı Oku ve Anla

**Her ajan için**:
```bash
for agent in "$REPO_GOD_PATH/.claude/agents/"*.md; do
  [ -f "$agent" ] || continue
  echo "=== $(basename $agent) ==="
  head -20 "$agent"
  echo "..."
done
```

**Her skill için**:
```bash
for skill_dir in "$REPO_GOD_PATH/.claude/skills/"*/; do
  [ -d "$skill_dir" ] || continue
  skill_name=$(basename "$skill_dir")
  skill_file="$skill_dir/SKILL.md"
  if [ -f "$skill_file" ]; then
    echo "=== SKILL: $skill_name ==="
    head -30 "$skill_file"
    echo "..."
  fi
done
```

**Her hook için**:
```bash
for hook in "$REPO_GOD_PATH/.claude/hooks/"*.sh; do
  [ -f "$hook" ] || continue
  echo "=== $(basename $hook) ==="
  head -20 "$hook"
  echo "..."
done
```

### Adım 4: Envanter Dosyası Oluştur

`.claude/context/repo-god-inventory.md` yazılır:

```markdown
# REPO GOD ENVANTERİ — The Creator

**Son keşif**: {YYYY-MM-DD HH:MM}
**Repo God Konumu**: `{REPO_GOD_PATH}`

## 📦 AJANLAR ({total-sayı})

### ✅ The Creator için KULLANILACAK

| Ajan | Dosya | Kullanım | The Creator takımında karşılığı |
|------|-------|----------|----------------------------------|
| code-reviewer | `{path}` | PR review, linting | dev-agent'ı güçlendirir |
| test-writer | `{path}` | Jest/Playwright test üretimi | qa-agent'a delege |
| deploy-master | `{path}` | CI/CD kurulumu | orchestrator manual task listesi |
| security-auditor | `{path}` | SAST benzeri | hacker agent'ı güçlendirir |

### ⚠️ KISMEN UYGULANABİLİR (Uyarlama gerekli)

| Ajan | Neden uyarlanmalı | Nasıl |
|------|-------------------|-------|
| mobile-ui-designer | The Creator web-first | Sadece responsive audit için |

### ❌ ALAKASIZ

| Ajan | Neden |
|------|-------|
| flutter-builder | The Creator web SaaS |
| ios-specialist | N/A |

## 🛠 SKILLS ({total-sayı})

### Kullanılacaklar

| Skill | Trigger | Yarar |
|-------|---------|-------|
| nextjs-app-router | Route/API yazımı | Best practices |
| supabase-rls | RLS policy yazımı | Güvenlik |
| stripe-integration | Webhook, billing | Ödeme güvenliği |
| typescript-strict | TS kodu | Type safety |
| react-patterns | Component yazımı | Kalite |
| seo-schema | Schema markup | SEO |
| playwright-e2e | E2E test | QA |

### Gerektiğinde kullanılacaklar

| Skill | Ne zaman |
|-------|----------|
| docker-compose | Self-host seçeneği için |
| kubernetes-basics | Enterprise tier için |

## 🪝 HOOKS ({total-sayı})

| Hook | Dosya | The Creator'a uygulanabilir mi? |
|------|-------|--------------------------------|
| pre-commit-lint.sh | `{path}` | ✅ Kopyala |
| pre-push-test.sh | `{path}` | ✅ Kopyala |
| post-deploy-smoke.sh | `{path}` | ✅ Kopyala (Vercel webhook ile) |
| pre-edit.sh | `{path}` | ✓ Mevcut version yeter |
| post-agent.sh | `{path}` | ✓ Mevcut version yeter |

## ⌨️ COMMANDS ({total-sayı})

| Komut | Açıklama | The Creator'a alınsın mı? |
|-------|----------|---------------------------|
| /refactor | Refactor önerileri | ✓ Çok faydalı |
| /optimize | Performance optimize | ✓ Faydalı |
| /debug | Debug helper | ✓ Faydalı |
| /test-gen | Test generation | ✓ qa-agent ile combine |
| /mobile-simulate | Mobile simülasyon | ⚠ Gelecek için |

## 📚 KILAVUZ DOKÜMANTASYON

Repo God'un root'unda varsa:
- `README.md`: Nasıl kullanılır
- `PHILOSOPHY.md`: Tasarım ilkeleri
- `CONTRIBUTING.md`: Yeni ajan nasıl eklenir

Bu dosyaları oku, genel yaklaşımı benimse.

## 🎯 BU PROJEDE KULLANIM STRATEJİSİ

### Hemen kopyala
```bash
# The Creator için özellikle yararlı skill'leri al
cp -r "$REPO_GOD_PATH/.claude/skills/nextjs-app-router" .claude/skills/
cp -r "$REPO_GOD_PATH/.claude/skills/supabase-rls" .claude/skills/
cp -r "$REPO_GOD_PATH/.claude/skills/stripe-integration" .claude/skills/
cp "$REPO_GOD_PATH/.claude/hooks/pre-commit-lint.sh" .claude/hooks/
cp "$REPO_GOD_PATH/.claude/commands/refactor.md" .claude/commands/
chmod +x .claude/hooks/*.sh
```

### Reference olarak kullan (kopyalama)
- Global skill'ler Mustafa merkezi tutuyor
- Her projede farklı adaptasyon değil, tek güncellenmeli

### The Creator'a özgü uzatma
Repo God'daki `code-reviewer` ajanı → kopyala + SaaS odaklı kuralları ekle:
- "Stripe webhook handler'larda idempotency zorunlu"
- "RLS policy her tabloda"
- "API route'ta auth() middleware"
- "AI call'lardan önce cost check"

## 🔄 SYNC STRATEJİSİ

Mustafa Repo God'u güncellediğinde:
1. `/discover-repo-god` tekrar çalıştır
2. Envanter güncellenir
3. Yeni varlıklar highlight edilir
4. Mevcut kopyaların güncel olup olmadığı kontrol edilir

```bash
# Kopya sync check
for skill_dir in .claude/skills/*/; do
  skill_name=$(basename "$skill_dir")
  if [ -d "$REPO_GOD_PATH/.claude/skills/$skill_name" ]; then
    diff -q "$skill_dir/SKILL.md" "$REPO_GOD_PATH/.claude/skills/$skill_name/SKILL.md" || echo "⚠ $skill_name güncel değil"
  fi
done
```

## 💡 YENİ VARLIK ÖNERİSİ

Bu keşif sırasında fark ettim ki The Creator için şunlar eksik Repo God'da:
- **saas-pricing-advisor** ajan — pricing stratejisi
- **pipeline-engine-patterns** skill — workflow builder'lar için
- **ai-cost-tracker** skill — API cost management
- **mcp-integration** skill — MCP server yazımı

Bunları Repo God'a eklemen Mustafa için faydalı olur. Ama şimdilik bu projede lokal olarak ele alıyorum.

---

## ÖZETLEME

- **Toplam keşfedilen**: {X} ajan, {Y} skill, {Z} hook, {W} komut
- **The Creator'a kopyalandı**: {X} skill, {Y} hook, {Z} komut
- **Reference edilen**: {X} skill (güncellemede otomatik fayda)
- **Önerilen Repo God eklentisi**: {X} yeni varlık

🎉 **Repo God entegrasyonu tamamlandı!**
```

## Örnek Kullanım

```
/discover-repo-god
```

Çıktı:
```
🔍 The Repo God keşfediliyor...

✓ Bulundu: /home/mustafa/projects/the-repo-god

📦 Envanter çıkarılıyor:
  - 12 ajan bulundu
  - 23 skill bulundu
  - 8 hook bulundu
  - 15 slash komut bulundu

📊 Analiz:
  - The Creator için uygun: 18 skill, 9 ajan
  - Kopyalanacak: 7 skill, 3 hook, 4 komut
  - Reference edilecek: 11 skill

✍ Envanter oluşturuldu: .claude/context/repo-god-inventory.md

🎁 Öneri:
  - 4 yeni SaaS-spesifik varlık Repo God'a eklenirse faydalı
  - Detaylar envanter dosyasında

🎉 Entegrasyon tamamlandı!
```

## Argümanla Çağırma

```
/discover-repo-god /Users/mustafa/code/the-repo-god
```

Repo God yolu belliyse doğrudan verebilirsin.

## İlk Kurulum Sonrası

`/discover-repo-god` bir kez çalıştıktan sonra envanter `.claude/context/repo-god-inventory.md`'de saklanır.

Sonraki `/run-full-audit` çağrılarında orchestrator bu envanteri okur, yeniden discovery yapmaya gerek kalmaz (ancak Repo God güncellendiyse `/discover-repo-god` tekrar çalıştırmalı).

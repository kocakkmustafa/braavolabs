#!/bin/bash
# The Creator Ajan Takımı — Kurulum Doğrulama Script'i
# Projenin kök dizininde çalıştır: bash setup-check.sh

set -e

echo ""
echo "🚀 THE CREATOR AJAN TAKIMI — KURULUM KONTROL"
echo "=============================================="
echo ""

ERRORS=0
WARNINGS=0

# 1. CLAUDE.md var mı?
if [ -f "CLAUDE.md" ]; then
    echo "✅ CLAUDE.md var"
else
    echo "❌ CLAUDE.md eksik — projenin köküne kopyalanmalı"
    ERRORS=$((ERRORS+1))
fi

# 2. .claude/ dizini
if [ -d ".claude" ]; then
    echo "✅ .claude/ dizini var"
else
    echo "❌ .claude/ dizini eksik"
    ERRORS=$((ERRORS+1))
fi

# 3. Ajanlar
AGENTS=("hacker" "user" "dev-agent" "qa-agent" "marketing-agent" "ads-agent" "seo-agent" "ux-agent" "content-agent" "orchestrator")
AGENT_COUNT=0
for agent in "${AGENTS[@]}"; do
    if [ -f ".claude/agents/${agent}.md" ]; then
        AGENT_COUNT=$((AGENT_COUNT+1))
    else
        echo "⚠️  .claude/agents/${agent}.md eksik"
        WARNINGS=$((WARNINGS+1))
    fi
done
echo "✅ ${AGENT_COUNT}/10 ajan tanımı mevcut"

# 4. Slash komutları
COMMANDS=("run-full-audit" "run-agent" "next-cycle" "status" "daily-briefing" "discover-repo-god")
CMD_COUNT=0
for cmd in "${COMMANDS[@]}"; do
    if [ -f ".claude/commands/${cmd}.md" ]; then
        CMD_COUNT=$((CMD_COUNT+1))
    fi
done
echo "✅ ${CMD_COUNT}/6 slash komutu mevcut"

# 5. Hook'lar
if [ -f ".claude/hooks/pre-edit.sh" ] && [ -x ".claude/hooks/pre-edit.sh" ]; then
    echo "✅ pre-edit hook var ve çalıştırılabilir"
elif [ -f ".claude/hooks/pre-edit.sh" ]; then
    echo "⚠️  pre-edit hook var ama çalıştırılabilir değil. Düzelt: chmod +x .claude/hooks/*.sh"
    WARNINGS=$((WARNINGS+1))
else
    echo "❌ pre-edit hook eksik"
    ERRORS=$((ERRORS+1))
fi

if [ -f ".claude/hooks/post-agent.sh" ] && [ -x ".claude/hooks/post-agent.sh" ]; then
    echo "✅ post-agent hook var ve çalıştırılabilir"
else
    echo "⚠️  post-agent hook eksik veya çalıştırılabilir değil"
    WARNINGS=$((WARNINGS+1))
fi

# 6. Git repo
if [ -d ".git" ]; then
    echo "✅ Git repo inicialize edilmiş"
    
    # Uncommitted changes var mı?
    if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
        echo "⚠️  Commit'lenmemiş değişiklik var. İlk cycle'dan önce commit al."
        WARNINGS=$((WARNINGS+1))
    fi
else
    echo "❌ Git repo yok. 'git init && git add -A && git commit -m \"baseline\"' çalıştır."
    ERRORS=$((ERRORS+1))
fi

# 7. Context dizini
if [ -d ".claude/context" ]; then
    echo "✅ .claude/context/ dizini hazır"
else
    mkdir -p .claude/context/reports
    mkdir -p .claude/context/backups
    mkdir -p .claude/context/archive
    mkdir -p .claude/context/logs
    mkdir -p .claude/context/triggers
    echo "✅ .claude/context/ dizini oluşturuldu"
fi

# 8. docs/ dizini
if [ -d "docs" ]; then
    echo "✅ docs/ dizini var"
else
    mkdir -p docs/roadmap
    mkdir -p docs/daily
    mkdir -p docs/marketing
    mkdir -p docs/technical
    echo "✅ docs/ dizini oluşturuldu"
fi

# 9. Claude CLI kurulu mu?
if command -v claude &> /dev/null; then
    CLAUDE_VERSION=$(claude --version 2>/dev/null || echo "bilinmiyor")
    echo "✅ Claude Code CLI kurulu ($CLAUDE_VERSION)"
else
    echo "❌ Claude Code CLI kurulu değil. Kur: npm install -g @anthropic-ai/claude-code"
    ERRORS=$((ERRORS+1))
fi

# 10. Repo God kontrolü
echo ""
echo "🔥 THE REPO GOD KEŞFİ"
echo "----------------------"

REPO_GOD_PATH=""
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
    break
  fi
done

if [ -z "$REPO_GOD_PATH" ]; then
  # Derin arama
  REPO_GOD_PATH=$(find "$HOME" -maxdepth 5 -type d \( -iname "*repo*god*" \) 2>/dev/null | head -1)
fi

if [ -n "$REPO_GOD_PATH" ]; then
  echo "✅ Repo God bulundu: $REPO_GOD_PATH"
  
  # Agent sayısı
  AGENT_COUNT=$(ls -1 "$REPO_GOD_PATH/.claude/agents/"*.md 2>/dev/null | wc -l)
  SKILL_COUNT=$(ls -1d "$REPO_GOD_PATH/.claude/skills/"*/ 2>/dev/null | wc -l)
  HOOK_COUNT=$(ls -1 "$REPO_GOD_PATH/.claude/hooks/"*.sh 2>/dev/null | wc -l)
  CMD_COUNT=$(ls -1 "$REPO_GOD_PATH/.claude/commands/"*.md 2>/dev/null | wc -l)
  
  echo "   📦 ${AGENT_COUNT} ajan, ${SKILL_COUNT} skill, ${HOOK_COUNT} hook, ${CMD_COUNT} komut"
else
  echo "⚠️  Repo God bulunamadı (henüz kurulmamış olabilir)"
  echo "   İlk /run-full-audit çalıştığında orchestrator manuel yolu soracak."
  echo "   Veya /discover-repo-god <path> komutu ile elle gösterebilirsin."
  WARNINGS=$((WARNINGS+1))
fi

echo ""
echo "=============================================="
echo "SONUÇ"
echo "=============================================="

if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo "✨ HER ŞEY HAZIR"
    echo ""
    echo "İlk cycle'ı başlatmak için:"
    echo "  $ claude"
    echo "  > /discover-repo-god"
    echo "  > /run-full-audit"
    echo ""
elif [ $ERRORS -eq 0 ]; then
    echo "✅ KULLANIMA HAZIR (${WARNINGS} uyarı)"
    echo "Uyarıları giderirsen daha iyi olur."
    echo ""
    echo "İlk cycle'ı başlatmak için:"
    echo "  $ claude"
    echo "  > /run-full-audit"
    echo ""
else
    echo "❌ ${ERRORS} HATA, ${WARNINGS} UYARI"
    echo "Hataları düzeltmeden çalıştırma."
    exit 1
fi

#!/usr/bin/env bash
# Post-agent hook — The Creator ajan takımı
# Her ajan çalışması sonrası rapor doğrulama yapar

set -e

AGENT="${CLAUDE_AGENT_NAME:-unknown}"
TODAY=$(date +%Y-%m-%d)
REPORT_FILE=".claude/context/reports/${AGENT}-${TODAY}.md"

# Log
mkdir -p .claude/context/logs
echo "[$(date)] Post-agent: $AGENT finished" >> .claude/context/logs/hooks.log

# Rapor yazıldı mı kontrolü
if [ ! -f "$REPORT_FILE" ]; then
  echo "⚠ Uyarı: $AGENT raporunu yazmamış ($REPORT_FILE bulunamadı)"
  # Uyarı log'a yaz ama fail etme
  echo "[$(date)] WARNING: $AGENT no report" >> .claude/context/logs/hooks.log
  exit 0
fi

# Rapor boyutu kontrolü
REPORT_SIZE=$(wc -c < "$REPORT_FILE")
if [ "$REPORT_SIZE" -lt 500 ]; then
  echo "⚠ Uyarı: $AGENT raporu çok kısa ($REPORT_SIZE bayt), yeterince detaylı olmayabilir"
  echo "[$(date)] WARNING: $AGENT report too short ($REPORT_SIZE bytes)" >> .claude/context/logs/hooks.log
fi

# Özet çıkar (debugging için)
if [ -f "$REPORT_FILE" ]; then
  echo "[$(date)] $AGENT report: $REPORT_SIZE bytes" >> .claude/context/logs/hooks.log
  echo "---" >> .claude/context/logs/hooks.log
  head -20 "$REPORT_FILE" >> .claude/context/logs/hooks.log
  echo "===" >> .claude/context/logs/hooks.log
fi

# Orchestrator için trigger dosyası
if [ "$AGENT" != "orchestrator" ]; then
  mkdir -p .claude/context/triggers
  touch ".claude/context/triggers/${AGENT}-done"
fi

exit 0

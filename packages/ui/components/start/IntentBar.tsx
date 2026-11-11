"use client";
/**
 * BRA-UX-05a — Niyet Çubuğu (04-design.md §5.1). Serbest metin + "Anladığım: Sohbet · İş · Ajan" önizlemesi.
 * Sınıflayıcı YEREL bir ipucudur (sunucuda niyet sınıflayıcı ucu yok); sunucudaki `POST /jobs/plan` kendi kararını verir.
 * Güven düşükse varsayılan SOHBET; iş planına yalnız yüksek güven ya da kullanıcı "İş"i seçerse gidilir.
 */
import { useRef, useState, type KeyboardEvent } from "react";
import { INTENT_KINDS, classifyIntent, effectiveIntent, flowForIntent, type IntentKind } from "../../lib/ux-lab/intent";
import type { T } from "../plan/PlanParts";
import { btn, btnPrimary, glass, muted } from "./styles";

export type IntentFlow = "chat" | "plan" | "agent";

export function IntentBar({ t, busy, onSubmit }: { t: T; busy: boolean; onSubmit: (flow: IntentFlow, text: string) => void }) {
  const [value, setValue] = useState("");
  const [override, setOverride] = useState<IntentKind | null>(null);
  const radios = useRef<Record<string, HTMLButtonElement | null>>({});
  const guess = classifyIntent(value);
  const kind = effectiveIntent(guess, override);
  const empty = !value.trim();
  const submit = () => { if (!empty && !busy) { onSubmit(flowForIntent(kind), value.trim()); setOverride(null); } };
  /** Roving tabindex + ok tuşları (radiogroup): odak seçili seçeneğe, oklar seçimi taşır. */
  const move = (e: KeyboardEvent, from: IntentKind) => {
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl"; // RTL'de (ar) yatay oklar yön değiştirir
    const fwd = rtl ? "ArrowLeft" : "ArrowRight", back = rtl ? "ArrowRight" : "ArrowLeft";
    const step = e.key === fwd || e.key === "ArrowDown" ? 1 : e.key === back || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = INTENT_KINDS[(INTENT_KINDS.indexOf(from) + step + INTENT_KINDS.length) % INTENT_KINDS.length];
    setOverride(next);
    radios.current[next]?.focus();
  };
  return (
    <form data-testid="intent-bar" style={{ ...glass, display: "grid", gap: 10 }} onSubmit={(e) => { e.preventDefault(); submit(); }} aria-label={t("app.intent.barLabel")}>
      <label htmlFor="intent-text" style={{ fontWeight: 700 }}>{t("app.intent.label")}</label>
      <textarea id="intent-text" rows={2} maxLength={4000} value={value} placeholder={t("app.intent.placeholder")}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { /* 229: Safari IME onayı */ e.preventDefault(); submit(); } }}
        style={{ resize: "vertical", minHeight: 56, padding: 10, borderRadius: 10, border: "1px solid var(--color-outline-variant)", background: "var(--color-surface-container-low, transparent)", color: "var(--color-on-surface)" }} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span id="intent-understood" style={muted}>{t("app.intent.understood")}</span>
        <div role="radiogroup" aria-labelledby="intent-understood" style={{ display: "flex", gap: 6 }}>
          {INTENT_KINDS.map((k) => (
            <button key={k} ref={(el) => { radios.current[k] = el; }} type="button" role="radio" aria-checked={kind === k} tabIndex={kind === k ? 0 : -1}
              onClick={() => setOverride(k)} onKeyDown={(e) => move(e, k)}
              // `border` kısayolunu `borderColor` ile KARIŞTIRMA: React seçimi kaldırınca uzun biçimi siler ve kısayolun rengi sıfırlanır.
              style={{ ...btn, padding: "4px 14px", ...(kind === k ? { background: "var(--color-primary)", color: "var(--color-on-primary)", border: "1px solid transparent" } : {}) }}>
              {t(`app.intent.kind.${k}`)}
            </button>
          ))}
        </div>
        <button type="submit" disabled={busy || empty} style={{ ...btnPrimary, marginInlineStart: "auto", opacity: busy || empty ? 0.6 : 1 }}>{t(`app.intent.submit.${kind}`)}</button>
      </div>
      <div style={muted}>
        {!empty && !override && guess.confidence === "low" ? `${t("app.intent.lowConfidence")} ` : ""}
        {t("app.intent.previewNote")}
      </div>
    </form>
  );
}

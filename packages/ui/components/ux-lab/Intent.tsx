"use client";
/** BRA-UX-04 — Niyet Çubuğu ve üç akış paneli: sohbet (E1/E2), iş tarif et → plan kartı → çalıştır (E3/E4), ajan oluştur (E9). */
import { useState } from "react";
import { INTENT_KINDS, classifyIntent, effectiveIntent, flowForIntent, type IntentKind } from "../../lib/ux-lab/intent";
import { START_BLOCKED, type PlanState, type StartErrorKind } from "../../lib/planFlow";
import type { FailureKind } from "../../lib/localized-error";
import { costRangeText } from "../plan/PlanParts";
import type { ComposeResult, LabCompany } from "../../lib/ux-lab/source";
import { Alert, NeedsApi, btn, btnPrimary, flat, glass, muted } from "./ui";

const KIND_LABEL: Record<IntentKind, string> = { chat: "Sohbet", job: "İş", agent: "Ajan" };
const SUBMIT_LABEL: Record<IntentKind, string> = { chat: "Sohbet başlat", job: "Planla", agent: "Ajanı oluştur" };

export function IntentBar({ busy, onSubmit }: { busy: boolean; onSubmit: (flow: "chat" | "plan" | "agent", text: string) => void }) {
  const [value, setValue] = useState("");
  const [override, setOverride] = useState<IntentKind | null>(null);
  const guess = classifyIntent(value);
  const kind = effectiveIntent(guess, override);
  const submit = () => { if (value.trim() && !busy) onSubmit(flowForIntent(kind), value.trim()); };
  return (
    <form style={{ ...glass, display: "grid", gap: 10 }} onSubmit={(e) => { e.preventDefault(); submit(); }} aria-label="Niyet çubuğu">
      <label htmlFor="uxl-intent" style={{ fontWeight: 700 }}>Ne yapmak istiyorsun?</label>
      <textarea id="uxl-intent" rows={2} maxLength={4000} value={value} placeholder="Bir iş tarif et, soru sor ya da bir ajan iste…"
        onChange={(e) => { setValue(e.target.value); }}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
        style={{ resize: "vertical", minHeight: 56, padding: 10, borderRadius: 10, border: "1px solid var(--color-outline-variant)", background: "var(--color-surface-container-low, transparent)", color: "var(--color-on-surface)" }} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span id="uxl-understood" style={muted}>Anladığım:</span>
        <div role="radiogroup" aria-labelledby="uxl-understood" style={{ display: "flex", gap: 6 }}>
          {INTENT_KINDS.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setOverride(k)}
              style={{ ...btn, minHeight: 44, padding: "4px 14px", ...(kind === k ? { background: "var(--color-primary)", color: "var(--color-on-primary)", borderColor: "transparent" } : {}) }}>{KIND_LABEL[k]}</button>
          ))}
        </div>
        <button type="submit" disabled={busy || !value.trim()} style={{ ...btnPrimary, marginInlineStart: "auto", opacity: busy || !value.trim() ? 0.6 : 1 }}>{SUBMIT_LABEL[kind]}</button>
      </div>
      <div style={muted}>
        {value.trim() && !override && guess.confidence === "low" ? "Emin değilim: sohbet olarak başlar; iş için “İş”i seç. " : ""}
        <NeedsApi what="Niyet sınıflayıcı" /> · önizleme örnektir.
      </div>
    </form>
  );
}

/** E1/E2: tek sütun konuşma. Sohbet ucu YOK (§14 önkoşul a): yanıt örnektir ve iş kaydı oluşmaz. */
export function ChatPanel({ text }: { text: string }) {
  return (
    <section style={{ ...flat, display: "grid", gap: 10 }} aria-label="Sohbet" data-testid="uxl-chat">
      <div style={{ ...glass, justifySelf: "end", maxWidth: "85%", whiteSpace: "pre-wrap" }}>{text}</div>
      <div style={{ ...flat, maxWidth: "85%", background: "var(--color-surface-container-high)" }}>
        Merhaba! Şu an yalnız sohbet başlatmayı gösteriyorum.
        <div style={muted}>ÖRNEK yanıt. <NeedsApi what="Sohbet ucu" /> · İş kaydı oluşturulmadı, plan çıkarılmadı, harcama yok.</div>
      </div>
    </section>
  );
}

const START_ERROR_TEXT: Record<StartErrorKind, string> = {
  approvalGate: "Bu iş şu an otomatik başlatılamaz: onay gerektiren bir adımı var ve adım onay kapısı kapalı. Bayrağı açmak kurucu kararıdır.",
  planChanged: "Plan sunucuda değişti. Yeniden planla.",
  workspaceRequired: "Önce bir şirket seç.",
  keyConflict: "Bu başlatma isteği zaten kullanıldı. Yeniden planla.",
  companyInactive: "Şirket duraklatılmış ya da arşivlenmiş; iş başlatılamaz.",
  noAgent: "Şirkette ajan yok; önce bir ajan oluştur.",
  validation: "Sunucu isteği kabul etmedi.",
  session: "Oturum süresi doldu; yeniden giriş yap.",
  forbidden: "Bu işlem için yetkin yok.",
  network: "Sunucuya ulaşılamadı. Bağlantını kontrol et.",
  rateLimit: "Çok fazla istek; biraz bekle.",
  timeout: "Sunucu zamanında yanıt vermedi.",
  generic: "Beklenmeyen bir hata oldu.",
};
const PLAN_ERROR_TEXT: Record<FailureKind, string> = { ...START_ERROR_TEXT } as Record<FailureKind, string>;
const RISK_LABEL = { low: "düşük", medium: "orta", high: "yüksek" } as const;

export function PlanPanel({ state, companies, workspaceId, onWorkspace, onStart, onCancel, onReplan }: {
  state: PlanState; companies: LabCompany[]; workspaceId: string; onWorkspace: (id: string) => void;
  onStart: () => void; onCancel: () => void; onReplan: () => void;
}) {
  if (state.phase === "idle" || state.phase === "started") return null;
  if (state.phase === "planning") return <div role="status" aria-busy="true" style={flat}>Plan hazırlanıyor…</div>;
  if (state.phase === "empty") return <div role="status" style={flat}>Bu mesaj bir iş gibi görünmüyor; sohbet olarak başlatabilirsin.</div>;
  if (state.phase === "planError") return <Alert onRetry={onReplan}>{PLAN_ERROR_TEXT[state.kind]}</Alert>;
  const { card } = state;
  const starting = state.phase === "starting";
  const blocked = !!state.error && START_BLOCKED.includes(state.error);
  const cost = costRangeText(card.estimate, "tr-TR");
  return (
    <article style={{ ...glass, display: "grid", gap: 10 }} aria-label={card.title} data-testid="uxl-plan-card" data-risk={card.risk}>
      <h2 style={{ margin: 0, fontSize: 18 }}>{card.title}</h2>
      <p style={{ margin: 0 }}>{card.goal}</p>
      <ol style={{ margin: 0, paddingInlineStart: 20, display: "grid", gap: 4 }}>
        {card.steps.map((s, i) => (
          <li key={i}>{s.title}{s.tool ? <span style={muted}> · araç: {s.tool}</span> : null}{s.needsApproval ? <strong> · ⚠ onay gerekli, {RISK_LABEL[s.risk]} risk</strong> : null}</li>
        ))}
      </ol>
      <div><strong>Risk:</strong> {RISK_LABEL[card.risk]} · <strong>Tahmini maliyet:</strong> {cost ?? "fiyat bilinmiyor"}</div>
      <div style={muted}>Adım başına model satırı: <NeedsApi what="model" /></div>
      {companies.length > 1 && (
        <label style={{ display: "grid", gap: 4 }}><span>Şirket</span>
          <select value={workspaceId} onChange={(e) => onWorkspace(e.target.value)} style={{ minHeight: 44 }}>
            <option value="">Seç…</option>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      )}
      {state.error && <div role="alert" style={{ color: "var(--color-error)", fontWeight: 600 }}>{START_ERROR_TEXT[state.error]}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" style={{ ...btnPrimary, opacity: starting || blocked ? 0.6 : 1 }} disabled={starting || blocked} aria-busy={starting} onClick={onStart}>{starting ? "Başlatılıyor…" : "Çalıştır ▸"}</button>
        {state.error === "planChanged" && <button type="button" style={btn} onClick={onReplan}>Yeniden planla</button>}
        <button type="button" style={btn} disabled={starting} onClick={onCancel}>Vazgeç</button>
      </div>
    </article>
  );
}

export type AgentState =
  | { phase: "idle" } | { phase: "working"; description: string }
  | { phase: "done"; description: string; result: ComposeResult } | { phase: "error"; description: string; message: string };

/** E9: ajan oluştur. `compose` ajanı HEMEN kaydeder (taslak ucu yok): canlı kipte bu açıkça yazılır. */
export function AgentPanel({ state, mode, onRetry }: { state: AgentState; mode: "sample" | "live"; onRetry: () => void }) {
  if (state.phase === "idle") return null;
  if (state.phase === "working") return <div role="status" aria-busy="true" style={flat}>Ajan oluşturuluyor…</div>;
  if (state.phase === "error") return <Alert onRetry={onRetry}>{state.message}</Alert>;
  const { result } = state;
  return (
    <article style={{ ...glass, display: "grid", gap: 8 }} aria-label="Yeni ajan" data-testid="uxl-agent">
      <h2 style={{ margin: 0, fontSize: 18 }}>{result.name} <span style={muted}>· rol: {result.role}</span></h2>
      <div><strong>Araçlar:</strong> {result.tools.length ? result.tools.join(", ") : "yok"}</div>
      {result.droppedTools.length > 0 && (
        <div role="alert" style={{ ...flat, borderColor: "var(--color-error)" }} data-testid="uxl-dropped">
          <strong>Çıkarılan araç ({result.droppedTools.length}):</strong> {result.droppedTools.join(", ")} bağlı değil; ajan bunlar olmadan oluşturuldu.
        </div>
      )}
      <div style={muted}>
        {mode === "live" ? "Ajan kaydedildi (taslak adımı yok: oluşturma ucu doğrudan kaydeder)." : "ÖRNEK sonuç: kayıt yapılmadı."} Yetki ve bütçe alanları: <NeedsApi what="kaynak alan" />
      </div>
    </article>
  );
}

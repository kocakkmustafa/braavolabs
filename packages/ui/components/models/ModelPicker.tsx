"use client";
/**
 * BRA-P0-06b — tek model seçici (bayrak `NEXT_PUBLIC_UX_MODELS` arkasındaki `/settings/models` sayfasında). Üç MEVCUT ucu tek yerde toplar:
 * `GET /research/compare/options` (seçenekler), `PATCH /companies/:id/agents/:agentId` (ajan modeli), `PUT /settings/ai-config` (hesap varsayılanı).
 * Yeni uç, yeni kip (DIRECT/CASCADE/COMPARE) yok. Rozetler 06a'nın `modeBadges` eşlemesinden.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "../../lib/api";
import type { CompareOptions } from "../../lib/compare";
import type { ModelRow } from "../../lib/ux-models/models";
import { buildPickerOptions, optionAllowedFor, pickerRequest, saveErrorKey, toPickerAgents, type PickerAgent } from "../../lib/ux-models/picker";

const DEFAULT_TARGET = "__default__";
const muted: React.CSSProperties = { color: "var(--color-on-surface-variant)", fontSize: 13 };
const field: React.CSSProperties = { width: "100%", minWidth: 0, minHeight: 44, padding: "0 12px", borderRadius: 10, background: "var(--color-surface-container)", color: "var(--color-on-surface)", border: "1px solid var(--color-surface-container-high)" };

type Status = "idle" | "saving" | "saved" | "error";
const targetOf = (t: string) => (t === DEFAULT_TARGET ? ({ kind: "default" } as const) : ({ kind: "agent", agentId: t } as const));

export default function ModelPicker({ token, companyId, rows, onChanged }: { token: string; companyId: string; rows: ModelRow[]; onChanged?: () => void }) {
  const t = useTranslations();
  const pt = (k: string, v?: Record<string, string | number>) => t(`app.models.${k}`, v);
  const [agents, setAgents] = useState<PickerAgent[]>([]);
  const [options, setOptions] = useState<CompareOptions | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [target, setTarget] = useState<string>(DEFAULT_TARGET);
  const [optionKey, setOptionKey] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errKey, setErrKey] = useState<string>("pickerError");
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    const ctl = new AbortController();
    setLoadFailed(false); setStatus("idle"); setAgents([]); setOptions(null);
    Promise.all([api.listAgents(token, companyId), api.compareOptions(token, companyId, ctl.signal)])
      .then(([a, o]) => {
        if (mine !== seq.current) return;
        const list = toPickerAgents(a);
        setAgents(list); setOptions(o);
        setTarget(list[0]?.id ?? DEFAULT_TARGET);
      })
      .catch(() => { if (mine === seq.current) setLoadFailed(true); });
    return () => ctl.abort();
  }, [token, companyId]);

  const choices = useMemo(() => buildPickerOptions(options, rows), [options, rows]);
  const allowed = useMemo(() => choices.filter((c) => optionAllowedFor(targetOf(target), c)), [choices, target]);
  useEffect(() => { setOptionKey((cur) => (allowed.some((c) => c.key === cur) ? cur : allowed[0]?.key ?? "")); }, [allowed]);

  const agent = agents.find((a) => a.id === target);
  const chosen = allowed.find((c) => c.key === optionKey);

  async function apply() {
    if (!chosen || status === "saving") return;
    const req = pickerRequest(targetOf(target), chosen);
    setStatus("saving");
    try {
      if (req.endpoint === "agent") {
        await api.updateAgent(token, companyId, req.agentId, req.body);
        setAgents((p) => p.map((a) => (a.id === req.agentId ? { ...a, model: req.body.model } : a)));
      } else {
        await api.setDefaultModel(token, req.body);
      }
      setStatus("saved");
      onChanged?.();
    } catch (e) { setErrKey(saveErrorKey(e)); setStatus("error"); }
  }

  return (
    <section data-testid="model-picker" aria-label={pt("pickerTitle")} style={{ marginTop: 20, display: "grid", gap: 10 }}>
      <h2 className="bv-title">{pt("pickerTitle")}</h2>
      <p style={muted}>{pt("pickerHelp")}</p>
      {loadFailed && <p role="alert" data-testid="model-picker-load-error" style={{ ...muted, color: "#FF8A8A" }}>{pt("pickerLoadError")}</p>}
      {!loadFailed && options && choices.length === 0 && <p data-testid="model-picker-empty" style={muted}>{pt("pickerEmpty")}</p>}
      {!loadFailed && options && choices.length > 0 && (
        <div style={{ display: "grid", gap: 10, maxWidth: 360, minWidth: 0 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={muted}>{pt("pickerTarget")}</span>
            <select data-testid="model-picker-target" value={target} onChange={(e) => { setTarget(e.target.value); setStatus("idle"); }} style={field}>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              <option value={DEFAULT_TARGET}>{pt("pickerDefault")}</option>
            </select>
          </label>
          {agent && <span data-testid="model-picker-current" style={muted}>{agent.model ? pt("pickerCurrent", { model: agent.model }) : pt("pickerCurrentUnknown")}</span>}
          {target === DEFAULT_TARGET && <span data-testid="model-picker-local-hint" style={muted}>{pt("pickerLocalHint")}</span>}
          <label style={{ display: "grid", gap: 4 }}>
            <span style={muted}>{pt("pickerModel")}</span>
            <select data-testid="model-picker-model" value={optionKey} onChange={(e) => { setOptionKey(e.target.value); setStatus("idle"); }} style={field}>
              {choices.map((c) => (
                <option key={c.key} value={c.key} disabled={!optionAllowedFor(targetOf(target), c)}>{c.model} ({c.provider}){c.badges.map((b) => ` · ${pt(`badge.${b}`)}`).join("")}</option>
              ))}
            </select>
          </label>
          <button type="button" data-testid="model-picker-apply" className="bv-btn bv-btn-primary bv-btn-sm" disabled={!chosen || status === "saving"} onClick={apply}>
            {status === "saving" ? pt("pickerSaving") : pt("pickerApply")}
          </button>
          <p role="status" aria-live="polite" data-testid="model-picker-status" style={{ ...muted, minHeight: 18, color: status === "error" ? "#FF8A8A" : undefined }}>
            {status === "saved" ? pt("pickerSaved") : status === "error" ? pt(errKey) : ""}
          </p>
        </div>
      )}
    </section>
  );
}

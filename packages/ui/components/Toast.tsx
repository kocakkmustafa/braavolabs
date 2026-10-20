"use client";
import { useTranslations as useLegacyTranslations } from "next-intl";


import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { useAppStore } from "../lib/store";

type ToastOwner = { revision: number; tenantId: string | null };

interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "info";
  duration?: number;
  owner: ToastOwner | null;
}

interface ToastContextValue {
  toast: (message: string, type: Toast["type"], duration: number, owner: ToastOwner | null) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast() {
  const { toast: enqueue } = useContext(ToastContext);
  const revision = useAppStore(s => s.sessionRevision);
  const tenantId = useAppStore(s => s.tenantId);
  const authenticated = useAppStore(s => Boolean(s.token));
  // Capture the initiating render's owner, never the owner at late delivery.
  // Public/login callers retain unscoped messages; token refresh keeps ownership.
  const toast = useCallback((message: string, type: Toast["type"] = "info", duration = 4000) => {
    enqueue(message, type, duration, authenticated ? { revision, tenantId } : null);
  }, [enqueue, revision, tenantId, authenticated]);
  return { toast };
}

function isVisible(owner: ToastOwner | null, revision: number, tenantId: string | null, authenticated: boolean) {
  return owner === null || (authenticated && owner.revision === revision && owner.tenantId === tenantId);
}

function canEnqueue(owner: ToastOwner | null) {
  const state = useAppStore.getState();
  return isVisible(owner, state.sessionRevision, state.tenantId, Boolean(state.token));
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const revision = useAppStore(s => s.sessionRevision);
  const tenantId = useAppStore(s => s.tenantId);
  const authenticated = useAppStore(s => Boolean(s.token));
  const visible = (toast: Toast) => isVisible(toast.owner, revision, tenantId, authenticated);

  const addToast = useCallback((message: string, type: Toast["type"], duration: number, owner: ToastOwner | null) => {
    if (!canEnqueue(owner)) return;
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => canEnqueue(owner) ? [...prev, { id, message, type, duration, owner }] : prev);
  }, []);

  // Rendering enforces the boundary before passive effects remove retired data.
  useEffect(() => {
    setToasts(previous => previous.filter(toast => canEnqueue(toast.owner)));
  }, [revision, tenantId, authenticated]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}

      {/* Toast container */}
      <div
        style={{
          position: "fixed",
          bottom: 24,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 300,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          pointerEvents: "none",
          maxWidth: 420,
          width: "90%",
        }}
      >
        {toasts.filter(visible).map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => removeToast(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const uiText = useLegacyTranslations("uiCopy");
  useEffect(() => {
    const timer = setTimeout(onDismiss, toast.duration ?? 4000);
    return () => clearTimeout(timer);
  }, [toast.duration, onDismiss]);

  const styles: Record<Toast["type"], { bg: string; border: string; icon: string; color: string }> = {
    success: { bg: "rgba(52,211,153,0.12)", border: "rgba(52,211,153,0.25)", icon: "check_circle", color: "var(--color-success)" },
    error: { bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.25)", icon: "error", color: "var(--color-error)" },
    info: { bg: "rgba(0,209,255,0.1)", border: "rgba(0,209,255,0.2)", icon: "info", color: "var(--color-primary)" },
  };

  const s = styles[toast.type];

  return (
    <div
      className="animate-slide-up"
      role={toast.type === "error" ? "alert" : "status"}
      aria-live={toast.type === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      style={{
        pointerEvents: "auto",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "12px 16px",
        borderRadius: 14,
        background: "var(--color-surface-container-low)",
        backdropFilter: "blur(20px)",
        border: `1px solid ${s.border}`,
        boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
      }}
    >
      <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 18, color: s.color }}>{s.icon}</span>
      <p className="text-sm flex-1" style={{ color: "var(--color-on-surface)", margin: 0 }}>{toast.message}</p>
      <button
        type="button"
        aria-label={uiText("m71c9ffc415a0")}
        onClick={onDismiss}
        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-on-surface-variant)", flexShrink: 0, padding: 8, minWidth: 32, minHeight: 32 }}
      >
        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 16 }}>close</span>
      </button>
    </div>
  );
}

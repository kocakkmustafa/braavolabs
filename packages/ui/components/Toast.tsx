"use client";

import { createContext, useContext, useState, useCallback, useEffect } from "react";

interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "info";
  duration?: number;
}

interface ToastContextValue {
  toast: (message: string, type?: Toast["type"], duration?: number) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, type: Toast["type"] = "info", duration = 4000) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, message, type, duration }]);
  }, []);

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
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => removeToast(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, toast.duration ?? 4000);
    return () => clearTimeout(timer);
  }, [toast.duration, onDismiss]);

  const styles: Record<Toast["type"], { bg: string; border: string; icon: string; color: string }> = {
    success: { bg: "rgba(52,211,153,0.12)", border: "rgba(52,211,153,0.25)", icon: "check_circle", color: "#34d399" },
    error: { bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.25)", icon: "error", color: "#f87171" },
    info: { bg: "rgba(0,209,255,0.1)", border: "rgba(0,209,255,0.2)", icon: "info", color: "#00d1ff" },
  };

  const s = styles[toast.type];

  return (
    <div
      className="animate-slide-up"
      style={{
        pointerEvents: "auto",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "12px 16px",
        borderRadius: 14,
        background: "rgba(16,19,26,0.95)",
        backdropFilter: "blur(20px)",
        border: `1px solid ${s.border}`,
        boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
      }}
    >
      <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 18, color: s.color }}>{s.icon}</span>
      <p className="text-sm flex-1" style={{ color: "#e1e2eb", margin: 0 }}>{toast.message}</p>
      <button
        onClick={onDismiss}
        style={{ background: "none", border: "none", cursor: "pointer", color: "#3c494e", flexShrink: 0, padding: 2 }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
      </button>
    </div>
  );
}

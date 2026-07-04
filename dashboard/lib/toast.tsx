"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertCircleIcon, CheckCircleIcon, InfoIcon } from "@/components/icons";

export type ToastTone = "info" | "success" | "error";

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastContextValue {
  toast: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

const TONE_STYLES: Record<ToastTone, string> = {
  info: "border-line",
  success: "border-accent/40",
  error: "border-critical/40",
};

function ToneIcon({ tone }: { tone: ToastTone }) {
  if (tone === "success")
    return <CheckCircleIcon className="size-4 shrink-0 text-accent" />;
  if (tone === "error")
    return <AlertCircleIcon className="size-4 shrink-0 text-critical" />;
  return <InfoIcon className="size-4 shrink-0 text-muted" />;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const toast = useCallback((message: string, tone: ToastTone = "info") => {
    const id = nextId.current++;
    setToasts((prev) => [...prev.slice(-3), { id, tone, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex max-w-md items-start gap-2.5 rounded-lg border bg-panel px-3.5 py-2.5 text-sm text-ink shadow-lg ${TONE_STYLES[t.tone]}`}
          >
            <span className="mt-0.5">
              <ToneIcon tone={t.tone} />
            </span>
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

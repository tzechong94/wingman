"use client";

import clsx from "clsx";
import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { LoaderIcon, XIcon } from "./icons";

export { clsx as cn };

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-on-accent hover:bg-accent-strong disabled:hover:bg-accent",
  secondary:
    "border border-line bg-panel text-ink hover:bg-panel-2 disabled:hover:bg-panel",
  ghost: "text-muted hover:bg-panel-2 hover:text-ink",
  danger:
    "border border-critical/30 bg-panel text-critical hover:bg-critical-soft disabled:hover:bg-panel",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-xs gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={clsx(
        "inline-flex items-center justify-center rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    >
      {loading && <LoaderIcon className="size-3.5 animate-spin" />}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Status chip: small dot + label, low saturation
// ---------------------------------------------------------------------------

export type ChipTone = "success" | "warning" | "critical" | "neutral";

const DOT_CLASSES: Record<ChipTone, string> = {
  success: "bg-accent",
  warning: "bg-warning",
  critical: "bg-critical",
  neutral: "bg-faint",
};

const CHIP_TEXT: Record<ChipTone, string> = {
  success: "text-accent-strong",
  warning: "text-warning",
  critical: "text-critical",
  neutral: "text-muted",
};

export function StatusChip({
  tone,
  label,
  className,
}: {
  tone: ChipTone;
  label: string;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        CHIP_TEXT[tone],
        className,
      )}
    >
      <span className={clsx("size-1.5 rounded-full", DOT_CLASSES[tone])} />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Card / panel
// ---------------------------------------------------------------------------

export function Card({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={clsx(
        "rounded-xl border border-line bg-panel shadow-[0_1px_2px_rgb(22_48_43/0.04)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spinner + centered states
// ---------------------------------------------------------------------------

export function Spinner({ className }: { className?: string }) {
  return <LoaderIcon className={clsx("animate-spin text-muted", className)} />;
}

export function CenteredState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="mb-1 text-faint">{icon}</div>}
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint && <div className="max-w-sm text-sm text-muted">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export interface TabOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

export function Tabs<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: TabOption<T>[];
}) {
  return (
    <div role="tablist" className="flex items-center gap-1 border-b border-line">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={clsx(
              "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "border-accent text-ink"
                : "border-transparent text-muted hover:text-ink",
            )}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function Modal({
  title,
  onClose,
  children,
  headerExtra,
  wide = false,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  headerExtra?: ReactNode;
  wide?: boolean;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={clsx(
          "flex max-h-[85vh] w-full flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-xl",
          wide ? "max-w-2xl" : "max-w-lg",
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="min-w-0 truncate text-sm font-semibold text-ink">
            {title}
          </h2>
          <div className="flex items-center gap-2">
            {headerExtra}
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-ink"
            >
              <XIcon className="size-4" />
            </button>
          </div>
        </div>
        <div className="min-h-0 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

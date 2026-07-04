"use client";

import { BusinessView } from "@/components/business/cockpit";
import { CustomerView } from "@/components/customer-view";
import { SnowflakeIcon } from "@/components/icons";
import { cn } from "@/components/ui";
import { ToastProvider } from "@/lib/toast";
import { useEffect, useState } from "react";

type Persona = "customer" | "business";

const PERSONA_KEY = "wingman.persona";

export default function Page() {
  // Resolved after mount so the persisted choice never causes a hydration
  // mismatch; the shell renders immediately either way.
  const [persona, setPersona] = useState<Persona | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(PERSONA_KEY);
    setPersona(saved === "business" ? "business" : "customer");
  }, []);

  const switchPersona = (next: Persona) => {
    setPersona(next);
    window.localStorage.setItem(PERSONA_KEY, next);
  };

  return (
    <ToastProvider>
      <div className="flex h-dvh flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-panel px-4">
          <div className="flex items-center gap-2.5">
            <div className="flex size-7 items-center justify-center rounded-lg bg-accent text-on-accent">
              <SnowflakeIcon className="size-4" />
            </div>
            <div className="leading-tight">
              <p className="text-sm font-semibold text-ink">Wingman</p>
              <p className="hidden text-[11px] text-muted sm:block">
                CoolBreeze Aircon Services
              </p>
            </div>
          </div>

          <div
            role="tablist"
            aria-label="Persona"
            className="flex items-center rounded-full border border-line bg-panel-2 p-0.5"
          >
            {(
              [
                { value: "customer", label: "Customer" },
                { value: "business", label: "Business" },
              ] as const
            ).map((opt) => {
              const active = persona === opt.value;
              return (
                <button
                  key={opt.value}
                  role="tab"
                  type="button"
                  aria-selected={active}
                  onClick={() => switchPersona(opt.value)}
                  className={cn(
                    "rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors",
                    active
                      ? "bg-panel text-ink shadow-sm"
                      : "text-muted hover:text-ink",
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          {persona === "customer" && <CustomerView />}
          {persona === "business" && <BusinessView />}
        </main>
      </div>
    </ToastProvider>
  );
}

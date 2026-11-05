"use client";

import { AlertTriangle, Loader2, X } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

const buttonStyles = {
  primary: "bg-accent text-on-accent hover:opacity-90",
  secondary: "bg-surface border border-line text-ink hover:bg-surface-2",
  ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
  danger: "bg-bad-soft text-bad hover:opacity-85",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof buttonStyles;
  busy?: boolean;
  size?: "sm" | "md";
}

export function Button({ variant = "secondary", busy, size = "md", className = "", children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer ${size === "sm" ? "h-7 px-2 text-[12.5px]" : "h-9 px-3 text-[13.5px]"} ${buttonStyles[variant]} ${className}`}
      {...rest}
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : null}
      {children}
    </button>
  );
}

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`bg-surface border border-line rounded-xl ${className}`}>{children}</div>;
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="text-ink-2 mt-0.5 max-w-2xl">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Note({ tone = "warn", children, onClose }: { tone?: "warn" | "bad"; children: ReactNode; onClose?: () => void }) {
  return (
    <div role="alert" className={`flex gap-2 rounded-lg px-3 py-2 text-[13px] ${tone === "bad" ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn"}`}>
      <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
      {onClose ? (
        <button type="button" aria-label="Dismiss" onClick={onClose} className="shrink-0 cursor-pointer">
          <X size={14} />
        </button>
      ) : null}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-ink-3 py-10 justify-center">
      <Loader2 size={16} className="animate-spin" />
      {label ?? "Loading"}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="text-center py-14 px-6">
      <p className="font-medium">{title}</p>
      {children ? <p className="text-ink-2 mt-1 max-w-md mx-auto">{children}</p> : null}
      {action ? <div className="mt-4 flex justify-center gap-2">{action}</div> : null}
    </div>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium ${tone === "accent" ? "bg-accent-soft text-accent" : "bg-surface-2 text-ink-2"}`}>
      {children}
    </span>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-line mb-5 overflow-x-auto overflow-y-hidden">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === value}
          onClick={() => onChange(tab.id)}
          className={`px-3 py-2 -mb-px border-b-2 whitespace-nowrap cursor-pointer font-medium text-[13.5px] ${tab.id === value ? "border-accent text-ink" : "border-transparent text-ink-3 hover:text-ink"}`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block min-w-0">
      <span className="block text-[12.5px] font-medium text-ink-2 mb-1">{label}</span>
      {children}
      {hint ? <span className="block text-[12px] text-ink-3 mt-1">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  "w-full h-9 rounded-lg border border-line bg-surface px-2.5 text-[13.5px] text-ink placeholder:text-ink-3 disabled:opacity-50";

export function Select({ value, onChange, options, disabled }: { value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; disabled?: boolean }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} className={inputClass}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

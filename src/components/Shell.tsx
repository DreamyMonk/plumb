"use client";

import { AlertTriangle, Bell, CalendarClock, CheckCircle2, Database, FileSpreadsheet, KeyRound, LayoutDashboard, LogOut, MessageSquare, Moon, Radio, Sigma, Sun, TrendingUp, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useApi, useLiveUpdates } from "@/lib/client";
import type { AlertRule, Dataset, LiveUpdate, Status } from "@/lib/types";

const NAV = [
  { href: "/", label: "Data", icon: Database, match: (path: string) => path === "/" || path.startsWith("/data") },
  { href: "/chat", label: "Chat", icon: MessageSquare, match: (path: string) => path.startsWith("/chat") },
  { href: "/dashboards", label: "Dashboards", icon: LayoutDashboard, match: (path: string) => path.startsWith("/dashboards") },
  { href: "/timeline", label: "Timeline", icon: CalendarClock, match: (path: string) => path.startsWith("/timeline") },
  { href: "/predict", label: "Predict", icon: TrendingUp, match: (path: string) => path.startsWith("/predict") },
  { href: "/metrics", label: "Metrics", icon: Sigma, match: (path: string) => path.startsWith("/metrics") },
  { href: "/alerts", label: "Alerts", icon: Bell, match: (path: string) => path.startsWith("/alerts") },
  { href: "/streams", label: "Streams", icon: Radio, match: (path: string) => path.startsWith("/streams") },
];

const TOAST_MS = 8000;

/** A short notice when an alert fires or clears while the app is open. */
function AlertToast({ alert, onClose }: { alert: NonNullable<LiveUpdate["alert"]>; onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onClose, TOAST_MS);
    return () => clearTimeout(timer);
  }, [alert, onClose]);
  const firing = alert.status === "firing";
  const Icon = firing ? AlertTriangle : CheckCircle2;
  return (
    <div role="status" className="fixed z-50 bottom-4 right-4 left-4 sm:left-auto sm:w-96 rounded-xl border border-line bg-surface shadow-lg p-3.5 flex gap-2.5 rise">
      <Icon size={17} className={`mt-0.5 shrink-0 ${firing ? "text-bad" : "text-good"}`} aria-hidden />
      <Link href="/alerts" onClick={onClose} className="min-w-0 flex-1">
        <p className="font-medium text-[13.5px]">{firing ? "Alert" : "Cleared"}: {alert.name}</p>
        <p className="text-[12.5px] text-ink-2 line-clamp-3">{alert.message}</p>
      </Link>
      <button type="button" aria-label="Dismiss" onClick={onClose} className="shrink-0 text-ink-3 hover:text-ink cursor-pointer"><X size={14} /></button>
    </div>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const stored = document.documentElement.dataset.theme;
    setDark(stored ? stored === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches);
  }, []);
  const toggle = () => {
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setDark(!dark);
    try {
      localStorage.setItem("theme", next);
    } catch {
      // The toggle still works for this visit without storage.
    }
  };
  return (
    <button type="button" onClick={toggle} aria-label={dark ? "Use light theme" : "Use dark theme"} className="p-1.5 rounded-md text-ink-3 hover:text-ink hover:bg-surface-2 cursor-pointer">
      {dark ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}

function LogoutButton() {
  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/login");
  };
  return (
    <button type="button" onClick={() => void logout()} aria-label="Log out" title="Log out" className="p-1.5 rounded-md text-ink-3 hover:text-ink hover:bg-surface-2 cursor-pointer">
      <LogOut size={15} />
    </button>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/login") return <>{children}</>;
  return <AppShell pathname={pathname}>{children}</AppShell>;
}

function AppShell({ children, pathname }: { children: ReactNode; pathname: string }) {
  const { data: status } = useApi<Status>("/api/status");
  const { data: datasets, refresh } = useApi<Dataset[]>("/api/datasets");
  const { data: rules, refresh: refreshRules } = useApi<AlertRule[]>("/api/alerts");
  const [toast, setToast] = useState<LiveUpdate["alert"] | null>(null);
  const firing = rules?.filter((r) => r.enabled && r.status === "firing").length ?? 0;

  const known = useRef(new Set<string>());
  useEffect(() => {
    known.current = new Set(datasets?.map((d) => d.id));
  }, [datasets]);
  useLiveUpdates((update) => {
    if (update.table && !known.current.has(update.table)) void refresh();
    if (update.alert) {
      setToast(update.alert);
      void refreshRules();
    }
  });

  useEffect(() => {
    const onChange = () => void refresh();
    window.addEventListener("datasets-changed", onChange);
    return () => window.removeEventListener("datasets-changed", onChange);
  }, [refresh]);

  return (
    <div className="min-h-full md:flex">
      <aside className="md:w-56 md:shrink-0 md:h-screen md:sticky md:top-0 bg-surface border-b md:border-b-0 md:border-r border-line flex md:flex-col">
        <div className="flex items-center gap-2 px-4 max-sm:px-2 h-14 shrink-0">
          <span className="grid place-items-center size-6 rounded-md bg-accent text-on-accent font-semibold text-[13px]" aria-hidden>
            P
          </span>
          <span className="font-semibold tracking-tight max-md:hidden">Plumb</span>
        </div>
        <nav aria-label="Main" className="flex md:flex-col gap-0.5 md:px-2 items-center md:items-stretch">
          {NAV.map(({ href, label, icon: Icon, match }) => {
            const active = match(pathname);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                aria-label={href === "/alerts" && firing ? `${label}, ${firing} firing` : label}
                className={`relative flex items-center gap-2 rounded-lg px-2.5 max-sm:px-1.5 h-9 font-medium text-[13.5px] whitespace-nowrap ${active ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`}
              >
                <Icon size={16} aria-hidden />
                <span className="max-sm:hidden">{label}</span>
                {href === "/alerts" && firing ? (
                  <span className="md:ml-auto max-md:absolute max-md:-top-0.5 max-md:-right-0.5 min-w-4 h-4 px-1 rounded-full bg-bad text-white text-[10.5px] font-semibold grid place-items-center tnum" aria-hidden>
                    {firing}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div className="hidden md:flex flex-col min-h-0 flex-1 mt-5">
          <p className="px-4 mb-1 text-[11.5px] font-medium text-ink-3">Tables</p>
          <div className="px-2 overflow-y-auto flex-1">
            {datasets?.length === 0 ? <p className="px-2.5 text-[12.5px] text-ink-3">None yet</p> : null}
            {datasets?.map((dataset) => (
              <Link
                key={dataset.id}
                href={`/data/${dataset.id}`}
                className={`flex items-center gap-2 rounded-md px-2.5 py-1 text-[13px] ${pathname === `/data/${dataset.id}` ? "text-ink bg-surface-2" : "text-ink-2 hover:bg-surface-2"}`}
              >
                <FileSpreadsheet size={13} className="shrink-0 text-ink-3" aria-hidden />
                <span className="truncate">{dataset.id}</span>
              </Link>
            ))}
          </div>
        </div>

        <div className="ml-auto md:ml-0 flex items-center gap-1 px-3 max-sm:px-1 md:h-12 md:border-t border-line shrink-0">
          {status && !status.aiConfigured ? (
            <span title="Add ANTHROPIC_API_KEY to .env.local to use chat, dashboards and AI review." className="flex items-center gap-1 text-[12px] text-warn truncate">
              <KeyRound size={13} aria-hidden /> <span className="max-md:hidden">No API key</span>
            </span>
          ) : (
            <span className="text-[11.5px] text-ink-3 truncate max-md:hidden">{status ? "AI ready" : ""}</span>
          )}
          <span className="ml-auto flex items-center">
            <ThemeToggle />
            <LogoutButton />
          </span>
        </div>
      </aside>
      <main className="flex-1 min-w-0">{children}</main>
      {toast ? <AlertToast alert={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
}

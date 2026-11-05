"use client";

import { Database, FileSpreadsheet, KeyRound, LayoutDashboard, MessageSquare, Moon, Sun, TrendingUp } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useApi } from "@/lib/client";
import type { Dataset, Status } from "@/lib/types";

const NAV = [
  { href: "/", label: "Data", icon: Database, match: (path: string) => path === "/" || path.startsWith("/data") },
  { href: "/chat", label: "Chat", icon: MessageSquare, match: (path: string) => path.startsWith("/chat") },
  { href: "/dashboards", label: "Dashboards", icon: LayoutDashboard, match: (path: string) => path.startsWith("/dashboards") },
  { href: "/predict", label: "Predict", icon: TrendingUp, match: (path: string) => path.startsWith("/predict") },
];

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

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { data: status } = useApi<Status>("/api/status");
  const { data: datasets, refresh } = useApi<Dataset[]>("/api/datasets");

  useEffect(() => {
    const onChange = () => void refresh();
    window.addEventListener("datasets-changed", onChange);
    return () => window.removeEventListener("datasets-changed", onChange);
  }, [refresh]);

  return (
    <div className="min-h-full md:flex">
      <aside className="md:w-56 md:shrink-0 md:h-screen md:sticky md:top-0 bg-surface border-b md:border-b-0 md:border-r border-line flex md:flex-col">
        <div className="flex items-center gap-2 px-4 h-14 shrink-0">
          <span className="grid place-items-center size-6 rounded-md bg-accent text-on-accent font-semibold text-[13px]" aria-hidden>
            S
          </span>
          <span className="font-semibold tracking-tight max-md:hidden">Sift</span>
        </div>
        <nav aria-label="Main" className="flex md:flex-col gap-0.5 md:px-2 items-center md:items-stretch">
          {NAV.map(({ href, label, icon: Icon, match }) => {
            const active = match(pathname);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                aria-label={label}
                className={`flex items-center gap-2 rounded-lg px-2.5 h-9 font-medium text-[13.5px] whitespace-nowrap ${active ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`}
              >
                <Icon size={16} aria-hidden />
                <span className="max-sm:hidden">{label}</span>
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

        <div className="ml-auto md:ml-0 flex items-center gap-1 px-3 md:h-12 md:border-t border-line shrink-0">
          {status && !status.aiConfigured ? (
            <span title="Add ANTHROPIC_API_KEY to .env.local to use chat, dashboards and AI review." className="flex items-center gap-1 text-[12px] text-warn truncate">
              <KeyRound size={13} aria-hidden /> <span className="max-md:hidden">No API key</span>
            </span>
          ) : (
            <span className="text-[11.5px] text-ink-3 truncate max-md:hidden">{status ? "Claude Sonnet 5.5" : ""}</span>
          )}
          <span className="ml-auto">
            <ThemeToggle />
          </span>
        </div>
      </aside>
      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}

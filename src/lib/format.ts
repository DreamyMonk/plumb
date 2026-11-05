import type { ValueFormat } from "./types";

export function compact(value: number, digits = 1): string {
  const abs = Math.abs(value);
  const fixed = (n: number) => String(Number(n.toFixed(digits)));
  if (abs >= 1e12) return `${fixed(value / 1e12)}T`;
  if (abs >= 1e9) return `${fixed(value / 1e9)}B`;
  if (abs >= 1e6) return `${fixed(value / 1e6)}M`;
  if (abs >= 1e4) return `${Number((value / 1e3).toFixed(1))}K`;
  return value.toLocaleString("en-US", { maximumFractionDigits: abs < 10 ? 2 : abs < 100 ? 1 : 0 });
}

export function formatValue(value: unknown, format: ValueFormat | undefined, currency?: string): string {
  if (value === null || value === undefined) return "–";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (format === "percent") {
    return `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
  }
  if (format === "currency") {
    return `${n < 0 ? "-" : ""}${currency ?? ""}${compact(Math.abs(n), 2)}`;
  }
  return compact(n, 2);
}

export function exactValue(value: unknown, format: ValueFormat | undefined, currency?: string): string {
  if (value === null || value === undefined) return "–";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (format === "percent") return formatValue(value, format, currency);
  const text = Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) < 100 ? 2 : Number.isInteger(n) ? 0 : 2 });
  return `${n < 0 ? "-" : ""}${format === "currency" ? (currency ?? "") : ""}${text}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Shortens ISO-like axis labels; anything else passes through. */
export function formatTick(value: unknown): string {
  const text = String(value ?? "");
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}, '${match[1].slice(2)}`;
  match = text.match(/^(\d{4})-(\d{2})$/);
  if (match) return `${MONTHS[Number(match[2]) - 1]} '${match[1].slice(2)}`;
  return text.length > 22 ? `${text.slice(0, 21)}…` : text;
}

/** Picks the tick format once for the whole axis, so labels stay consistent. */
export function axisFormatter(rows: Record<string, unknown>[], key: string): (value: unknown) => string {
  const monthly = rows.length > 1 && rows.every((row) => /^\d{4}-\d{2}-01/.test(String(row[key])));
  return monthly ? (value) => formatTick(String(value).slice(0, 7)) : formatTick;
}

export const humanize = (name: string) => name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export const timeAgo = (iso: string) => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
};

/** Neutralizes spreadsheet formulas in text cells (OWASP CSV injection). Numbers are left alone. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

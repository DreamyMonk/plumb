import { compact } from "../format";
import { detectAnomalies } from "../ml/anomaly";
import { addPeriods } from "../ml/forecast";
import type { AlertRule, Grain, WebhookFormat } from "../types";

// Pure decisions, kept apart from storage and the network so they can be tested exactly.

export interface Evaluation {
  status: "ok" | "firing";
  value: number | null;
  message: string;
  /** What fired, such as a period's date or an event's id. */
  key: string | null;
}

export interface Series {
  dates: string[];
  values: number[];
  grain: Grain;
  label: string;
}

/**
 * Drops a period that hasn't finished yet. Today's sales so far would always look like a
 * collapse next to a full day, so an alert would fire every morning.
 */
export function completePeriods(series: Series, today: string): Series {
  const last = series.dates.at(-1);
  if (!last || addPeriods(last, series.grain, 1) <= today) return series;
  return { ...series, dates: series.dates.slice(0, -1), values: series.values.slice(0, -1) };
}

const show = (value: number) => compact(value, 2);

export function checkThreshold(rule: Pick<AlertRule, "op" | "value">, series: Series): Evaluation {
  const date = series.dates.at(-1);
  const value = series.values.at(-1);
  if (date === undefined || value === undefined) return { status: "ok", value: null, message: "No complete period yet.", key: null };
  const limit = rule.value ?? 0;
  const breached = rule.op === "below" ? value < limit : value > limit;
  return {
    status: breached ? "firing" : "ok",
    value,
    key: date,
    message: breached
      ? `${series.label} was ${show(value)} for ${date}, ${rule.op === "below" ? "below" : "above"} your limit of ${show(limit)}.`
      : `${series.label} was ${show(value)} for ${date}, within your limit of ${show(limit)}.`,
  };
}

/** Daily data is compared with the same weekday a week earlier, so a quiet Sunday isn't a "drop". */
export function checkChange(rule: Pick<AlertRule, "changePct" | "direction">, series: Series): Evaluation {
  const back = series.grain === "day" ? 7 : 1;
  const n = series.values.length;
  if (n <= back) return { status: "ok", value: null, message: "Not enough history to compare yet.", key: null };
  const [value, base] = [series.values[n - 1], series.values[n - 1 - back]];
  const [date, baseDate] = [series.dates[n - 1], series.dates[n - 1 - back]];
  if (base === 0) return { status: "ok", value, message: `Can't compare ${date} with ${baseDate}, which was zero.`, key: date };
  const change = (value - base) / Math.abs(base);
  const threshold = (rule.changePct ?? 0) / 100;
  const direction = rule.direction ?? "drop";
  const breached = direction === "drop" ? change <= -threshold : direction === "rise" ? change >= threshold : Math.abs(change) >= threshold;
  const against = series.grain === "day" ? `${baseDate}, the same weekday a week earlier` : baseDate;
  const pct = Math.abs(change * 100).toFixed(1);
  const moved = pct === "0.0" ? `was unchanged at ${show(value)}` : `${change < 0 ? "fell" : "rose"} ${pct}% to ${show(value)}`;
  return {
    status: breached ? "firing" : "ok",
    value,
    key: date,
    message: `${series.label} ${moved} for ${date}, against ${show(base)} for ${against}.`,
  };
}

export function checkAnomaly(rule: Pick<AlertRule, "direction">, series: Series): Evaluation {
  const date = series.dates.at(-1);
  const value = series.values.at(-1);
  if (date === undefined || value === undefined) return { status: "ok", value: null, message: "No complete period yet.", key: null };
  const { anomalies } = detectAnomalies(series.dates, series.values, series.grain);
  const direction = rule.direction ?? "any";
  const hit = anomalies.find((a) => a.date === date && (direction === "any" || (direction === "drop" ? a.direction === "drop" : a.direction === "spike")));
  return hit
    ? { status: "firing", value, key: date, message: `${series.label} for ${date} was unusual: ${show(value)} against about ${show(hit.expected)} expected.` }
    : { status: "ok", value, key: date, message: `${series.label} for ${date} was in its usual range.` };
}

export function checkStale(rule: Pick<AlertRule, "staleMinutes" | "table">, updatedAt: string, now: Date): Evaluation {
  const minutes = (now.getTime() - Date.parse(updatedAt)) / 60_000;
  const limit = rule.staleMinutes ?? 60;
  const age = minutes < 120 ? `${Math.floor(minutes)} minutes` : `${(minutes / 60).toFixed(1)} hours`;
  return minutes > limit
    ? { status: "firing", value: minutes, key: "stale", message: `No new data in ${rule.table} for ${age}, longer than your limit of ${limit} minutes.` }
    : { status: "ok", value: minutes, key: null, message: `${rule.table} last changed ${age} ago.` };
}

export type Transition = "fire" | "resolve" | "error" | "none";

/**
 * Fires once when a breach starts, and again only for a different period or event. A breach
 * that simply continues stays quiet, so a webhook doesn't get the same message every minute.
 */
export function transition(previous: Pick<AlertRule, "status" | "firedKey" | "kind">, next: Evaluation | { status: "error" }): Transition {
  if (next.status === "error") return previous.status === "error" ? "none" : "error";
  if (next.status === "firing") return previous.status !== "firing" || previous.firedKey !== next.key ? "fire" : "none";
  // Incidents are single events; there's nothing to clear.
  return previous.status === "firing" && previous.kind !== "incident" ? "resolve" : "none";
}

/** The webhook body. Slack wants "text", Discord wants "content", anything else gets both plus details. */
export function webhookBody(format: WebhookFormat, text: string, details: Record<string, unknown>): Record<string, unknown> {
  if (format === "slack") return { text };
  if (format === "discord") return { content: text.slice(0, 2000) };
  return { text, ...details };
}

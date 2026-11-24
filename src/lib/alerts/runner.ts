import "server-only";
import { loadSeries } from "../analytics";
import { findMetric } from "../metrics";
import { inferBaseGrain } from "../ml/forecast";
import { alertHistory, alerts, datasets, events, newId, notifications } from "../store";
import { publishUpdate } from "../streams/bus";
import { withTableLock } from "../streams/lock";
import type { AlertHistoryEntry, AlertRule, Grain } from "../types";
import { checkAnomaly, checkChange, checkStale, checkThreshold, completePeriods, transition, webhookBody, type Evaluation } from "./rules";

const TICK_MS = 60_000;
/** Data-driven rules also run on a timer, as a safety net if a change was missed. */
const RECHECK_MS = 15 * 60_000;
const DEBOUNCE_MS = 2_000;
const WEBHOOK_TIMEOUT_MS = 10_000;

const localToday = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, in the server's timezone

async function evaluate(rule: AlertRule, now: Date): Promise<Evaluation> {
  if (rule.kind === "stale") {
    const dataset = rule.table ? await datasets.get(rule.table) : null;
    if (!dataset) throw new Error(`Table ${rule.table} no longer exists.`);
    return checkStale(rule, dataset.updatedAt, now);
  }
  if (rule.kind === "incident") {
    const since = rule.lastCheckedAt ?? rule.createdAt;
    const fresh = (await events.list())
      .filter((e) => e.category === "incident" && e.createdAt > since && (!rule.table || !e.table || e.table === rule.table))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (fresh.length === 0) return { status: "ok", value: 0, key: null, message: "No new incidents." };
    const titles = fresh.slice(-3).map((e) => `${e.title} (${e.date})`).join("; ");
    return { status: "firing", value: fresh.length, key: fresh.at(-1)!.id, message: `${fresh.length === 1 ? "New incident" : `${fresh.length} new incidents`}: ${titles}.` };
  }

  const metric = rule.metricId ? await findMetric(rule.metricId) : null;
  const table = metric?.table ?? rule.table;
  if (!table || !rule.dateColumn) throw new Error("This alert needs a table and a date column.");
  const loaded = await loadSeries(
    { table, dateColumn: rule.dateColumn, agg: "count", metric: metric?.id ?? null, grain: (rule.grain as Grain | null) ?? null },
    inferBaseGrain,
  );
  const series = completePeriods({ dates: loaded.dates, values: loaded.values, grain: loaded.grain, label: metric?.name ?? `Rows in ${table}` }, localToday());
  if (rule.kind === "threshold") return checkThreshold(rule, series);
  if (rule.kind === "change") return checkChange(rule, series);
  return checkAnomaly(rule, series);
}

async function deliver(rule: AlertRule, status: "firing" | "resolved", message: string): Promise<Pick<AlertHistoryEntry, "delivery" | "deliveryDetail">> {
  const settings = await notifications.get("notifications");
  if (!settings?.webhookUrl) return { delivery: "none" };
  const text = status === "firing" ? `[Plumb] ${rule.name}: ${message}` : `[Plumb] Cleared: ${rule.name}. ${message}`;
  try {
    const response = await fetch(settings.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookBody(settings.format, text, { alert: rule.name, status, message, kind: rule.kind, at: new Date().toISOString() })),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    return response.ok ? { delivery: "sent" } : { delivery: "failed", deliveryDetail: `The webhook answered ${response.status}.` };
  } catch (error) {
    return { delivery: "failed", deliveryDetail: error instanceof Error ? error.message : String(error) };
  }
}

/** Checks one rule, records any change of state, and notifies. Rules run one at a time each. */
export async function checkAlert(id: string): Promise<AlertRule | null> {
  return withTableLock(`alert:${id}`, async () => {
    const rule = await alerts.get(id).catch(() => null);
    if (!rule || !rule.enabled) return rule;
    const now = new Date();
    let result: Evaluation | { status: "error"; message: string };
    try {
      result = await evaluate(rule, now);
    } catch (error) {
      result = { status: "error", message: error instanceof Error ? error.message : String(error) };
    }

    const change = transition(rule, result);
    const next: AlertRule = { ...rule, lastCheckedAt: now.toISOString(), message: result.message };
    if (result.status !== "error") {
      next.status = result.status;
      next.lastValue = result.value;
    } else {
      next.status = "error";
    }
    if (change === "fire" || change === "resolve" || change === "error") {
      const status = change === "fire" ? "firing" : change === "resolve" ? "resolved" : "error";
      const sent = status === "error" || (status === "resolved" && !rule.notifyResolved) ? { delivery: "none" as const } : await deliver(rule, status, result.message);
      const entry: AlertHistoryEntry = { id: newId(), alertId: rule.id, alertName: rule.name, at: now.toISOString(), status, message: result.message, ...sent };
      await alertHistory.save(entry);
      if (change === "fire") {
        next.firedKey = (result as Evaluation).key;
        next.lastFiredAt = now.toISOString();
      }
      if (status !== "error") publishUpdate({ stream: "", table: null, target: "table", rows: 0, alert: { id: rule.id, name: rule.name, status, message: result.message } });
    }
    if (change === "resolve") next.firedKey = null;
    await alerts.save(next);
    return next;
  });
}

const globalForAlerts = globalThis as unknown as { __plumbAlerts?: { timer: ReturnType<typeof setInterval> | null; pending: Map<string, ReturnType<typeof setTimeout>> } };
const state = (globalForAlerts.__plumbAlerts ??= { timer: null, pending: new Map() });

async function rulesFor(scope: string): Promise<AlertRule[]> {
  const all = (await alerts.list()).filter((r) => r.enabled);
  if (scope === "events") return all.filter((r) => r.kind === "incident");
  const metricTables = new Map<string, string>();
  for (const rule of all) {
    if (rule.metricId) {
      const metric = await findMetric(rule.metricId).catch(() => null);
      if (metric) metricTables.set(rule.id, metric.table);
    }
  }
  return all.filter((r) => r.kind !== "incident" && (r.table === scope || metricTables.get(r.id) === scope));
}

/**
 * Called whenever a table or the event log changes. Bursts of changes, such as a stream's
 * batches, collapse into one check a couple of seconds later.
 */
export function requestCheck(scope: string | null): void {
  if (!scope) return;
  const existing = state.pending.get(scope);
  if (existing) clearTimeout(existing);
  state.pending.set(
    scope,
    setTimeout(() => {
      state.pending.delete(scope);
      void rulesFor(scope).then((rules) => Promise.all(rules.map((r) => checkAlert(r.id)))).catch(() => {});
    }, DEBOUNCE_MS),
  );
}

async function checkDue(): Promise<void> {
  const now = Date.now();
  for (const rule of await alerts.list()) {
    if (!rule.enabled) continue;
    const age = rule.lastCheckedAt ? now - Date.parse(rule.lastCheckedAt) : Infinity;
    // Staleness only changes with time passing, so it's checked every tick.
    if (rule.kind === "stale" || age >= RECHECK_MS) await checkAlert(rule.id).catch(() => {});
  }
}

export function startAlertScheduler(): void {
  if (state.timer) return;
  state.timer = setInterval(() => void checkDue(), TICK_MS);
  setTimeout(() => void checkDue(), 5_000);
}

export async function sendTestNotification(): Promise<{ ok: boolean; detail: string }> {
  const settings = await notifications.get("notifications");
  if (!settings?.webhookUrl) return { ok: false, detail: "Add a webhook URL first." };
  try {
    const response = await fetch(settings.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookBody(settings.format, "[Plumb] Test notification. Alerts will arrive here.", { test: true })),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    return response.ok ? { ok: true, detail: "Sent." } : { ok: false, detail: `The webhook answered ${response.status}.` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

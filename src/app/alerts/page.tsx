"use client";

import { AlertTriangle, BellRing, CheckCircle2, CircleDashed, Pause, Play, RefreshCw, Send, Trash2, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Empty, Field, inputClass, Note, PageHeader, Select, Spinner } from "@/components/ui";
import { api, post, useApi, useLiveUpdates } from "@/lib/client";
import { timeAgo } from "@/lib/format";
import type { AlertHistoryEntry, AlertKind, AlertRule, Dataset, Grain, Metric, NotificationSettingsView, WebhookFormat } from "@/lib/types";

const KINDS: { value: AlertKind; label: string; hint: string }[] = [
  { value: "change", label: "A metric drops or rises", hint: "Compares the latest full period with the one before. Daily data is compared with the same weekday last week." },
  { value: "threshold", label: "A metric passes a limit", hint: "Fires when the latest full period is above or below a number." },
  { value: "anomaly", label: "An unusual period", hint: "Uses the Timeline's detection, which allows for trend and weekly or yearly patterns." },
  { value: "stale", label: "No new data", hint: "Fires when a table hasn't changed for a while, such as when a pipeline stops." },
  { value: "incident", label: "An incident is logged", hint: "Fires when an incident event arrives, for example a failed dbt or Airflow run." },
];

const STATUS: Record<AlertRule["status"], { label: string; className: string; icon: typeof CheckCircle2 }> = {
  firing: { label: "Firing", className: "text-bad", icon: AlertTriangle },
  ok: { label: "OK", className: "text-good", icon: CheckCircle2 },
  error: { label: "Can't check", className: "text-warn", icon: XCircle },
  pending: { label: "Not checked yet", className: "text-ink-3", icon: CircleDashed },
};

const isDate = (type: string) => type === "date" || type === "datetime";

function describeRule(rule: AlertRule, metrics: Metric[]): string {
  const source = rule.metricId ? (metrics.find((m) => m.id === rule.metricId)?.name ?? "a deleted metric") : `rows in ${rule.table}`;
  const per = rule.grain ? ` per ${rule.grain}` : "";
  switch (rule.kind) {
    case "change":
      return `${source}${per} ${rule.direction === "rise" ? "rises" : rule.direction === "any" ? "moves" : "drops"} by ${rule.changePct}% or more`;
    case "threshold":
      return `${source}${per} goes ${rule.op} ${rule.value}`;
    case "anomaly":
      return `${source}${per} is unusual${rule.direction === "drop" ? " (drops only)" : rule.direction === "rise" ? " (spikes only)" : ""}`;
    case "stale":
      return `${rule.table} has no new data for ${rule.staleMinutes} minutes`;
    case "incident":
      return `an incident is logged${rule.table ? ` for ${rule.table}` : ""}`;
  }
}

function NewAlert({ datasets, metrics, onCreated }: { datasets: Dataset[]; metrics: Metric[]; onCreated: () => void }) {
  const [kind, setKind] = useState<AlertKind>("change");
  const [source, setSource] = useState(metrics[0] ? `metric:${metrics[0].id}` : datasets[0] ? `table:${datasets[0].id}` : "");
  const [dateColumn, setDateColumn] = useState("");
  const [grain, setGrain] = useState<"" | Grain>("day");
  const [op, setOp] = useState<"above" | "below">("below");
  const [value, setValue] = useState("");
  const [changePct, setChangePct] = useState("20");
  const [direction, setDirection] = useState<"drop" | "rise" | "any">("drop");
  const [staleTable, setStaleTable] = useState(datasets[0]?.id ?? "");
  const [staleMinutes, setStaleMinutes] = useState("60");
  const [name, setName] = useState("");
  const [notifyResolved, setNotifyResolved] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const usesSeries = kind === "change" || kind === "threshold" || kind === "anomaly";
  const sourceTable = source.startsWith("metric:") ? metrics.find((m) => `metric:${m.id}` === source)?.table : source.slice("table:".length);
  const dateColumns = useMemo(() => datasets.find((d) => d.id === sourceTable)?.columns.filter((c) => isDate(c.type)) ?? [], [datasets, sourceTable]);
  useEffect(() => setDateColumn(dateColumns[0]?.name ?? ""), [dateColumns]);

  const sourceOptions = [
    ...metrics.map((m) => ({ value: `metric:${m.id}`, label: `${m.name} (metric)` })),
    ...datasets.filter((d) => d.columns.some((c) => isDate(c.type))).map((d) => ({ value: `table:${d.id}`, label: `Row count of ${d.id}` })),
  ];

  const create = async () => {
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = { kind, notifyResolved, name: name.trim() || KINDS.find((k) => k.value === kind)!.label };
    if (usesSeries) {
      if (source.startsWith("metric:")) body.metricId = source.slice("metric:".length);
      else body.table = source.slice("table:".length);
      body.dateColumn = dateColumn;
      body.grain = grain || null;
      body.direction = direction;
    }
    if (kind === "threshold") Object.assign(body, { op, value: Number(value) });
    if (kind === "change") body.changePct = Number(changePct);
    if (kind === "stale") Object.assign(body, { table: staleTable, staleMinutes: Number(staleMinutes) });
    if (kind === "incident") body.table = null;
    try {
      await post("/api/alerts", body);
      setName("");
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <Field label="Alert me when" hint={KINDS.find((k) => k.value === kind)?.hint}>
        <Select value={kind} onChange={(v) => setKind(v as AlertKind)} options={KINDS} />
      </Field>
      {usesSeries ? (
        sourceOptions.length === 0 ? (
          <Note>Add a table with a date column first.</Note>
        ) : (
          <div className="grid sm:grid-cols-3 gap-3">
            <Field label="Watch"><Select value={source} onChange={setSource} options={sourceOptions} /></Field>
            <Field label="Date column"><Select value={dateColumn} onChange={setDateColumn} options={dateColumns.map((c) => ({ value: c.name, label: c.name }))} /></Field>
            <Field label="Per"><Select value={grain} onChange={(v) => setGrain(v as typeof grain)} options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }, { value: "", label: "Auto" }]} /></Field>
          </div>
        )
      ) : null}
      {kind === "threshold" ? (
        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="Fire when it goes"><Select value={op} onChange={(v) => setOp(v as typeof op)} options={[{ value: "below", label: "Below" }, { value: "above", label: "Above" }]} /></Field>
          <Field label="Limit"><input className={`${inputClass} tnum`} type="number" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
        </div>
      ) : null}
      {kind === "change" ? (
        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="Direction"><Select value={direction} onChange={(v) => setDirection(v as typeof direction)} options={[{ value: "drop", label: "Drops" }, { value: "rise", label: "Rises" }, { value: "any", label: "Either way" }]} /></Field>
          <Field label="By at least (%)"><input className={`${inputClass} tnum`} type="number" min={1} value={changePct} onChange={(e) => setChangePct(e.target.value)} /></Field>
        </div>
      ) : null}
      {kind === "anomaly" ? (
        <div className="max-w-xs">
          <Field label="Which way"><Select value={direction} onChange={(v) => setDirection(v as typeof direction)} options={[{ value: "any", label: "Spikes and drops" }, { value: "drop", label: "Drops only" }, { value: "rise", label: "Spikes only" }]} /></Field>
        </div>
      ) : null}
      {kind === "stale" ? (
        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="Table"><Select value={staleTable} onChange={setStaleTable} options={datasets.map((d) => ({ value: d.id, label: d.id }))} /></Field>
          <Field label="After (minutes)"><input className={`${inputClass} tnum`} type="number" min={1} value={staleMinutes} onChange={(e) => setStaleMinutes(e.target.value)} /></Field>
        </div>
      ) : null}
      <div className="grid sm:grid-cols-2 gap-3 items-end">
        <Field label="Name (optional)"><input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Revenue drop" /></Field>
        {kind !== "incident" ? (
          <label className="flex items-center gap-2 text-[13px] cursor-pointer pb-2">
            <input type="checkbox" checked={notifyResolved} onChange={(e) => setNotifyResolved(e.target.checked)} /> Also notify when it clears
          </label>
        ) : null}
      </div>
      {error ? <Note tone="bad">{error}</Note> : null}
      <Button variant="primary" busy={busy} disabled={usesSeries && (!dateColumn || sourceOptions.length === 0)} onClick={() => void create()}><BellRing size={14} /> Create alert</Button>
    </div>
  );
}

function Notifications() {
  const { data, setData } = useApi<NotificationSettingsView>("/api/alerts/settings");
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<WebhookFormat>("slack");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setFormat(data.format);
  }, [data]);

  const save = async (webhookUrl?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      setData(await api<NotificationSettingsView>("/api/alerts/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ webhookUrl, format }) }));
      setUrl("");
      setMessage({ ok: true, text: "Saved." });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    const result = await post<{ ok: boolean; detail: string }>("/api/alerts/settings");
    setMessage({ ok: result.ok, text: result.ok ? "Test message sent." : result.detail });
  };

  return (
    <Card className="p-5">
      <h2 className="font-semibold">Where alerts go</h2>
      <p className="text-[12.5px] text-ink-2 mb-3">Alerts always appear here. To also get them in Slack, Discord or another tool, add a webhook. Messages contain metric names, numbers and dates, never rows of data.</p>
      {data?.webhookConfigured ? <p className="text-[13px] mb-3">Sending to <span className="font-mono">{data.webhookHost}</span></p> : null}
      <div className="grid sm:grid-cols-[1fr_160px] gap-3">
        <Field label={data?.webhookConfigured ? "Replace webhook URL" : "Webhook URL"} hint="Treat it like a password. It's stored on this computer and never shown again.">
          <input className={`${inputClass} font-mono text-[12.5px]`} type="password" autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" />
        </Field>
        <Field label="Format"><Select value={format} onChange={(v) => setFormat(v as WebhookFormat)} options={[{ value: "slack", label: "Slack" }, { value: "discord", label: "Discord" }, { value: "json", label: "Other (JSON)" }]} /></Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" busy={busy} onClick={() => void save(url.trim() || undefined)}>Save</Button>
        {data?.webhookConfigured ? (
          <>
            <Button onClick={() => void test()}><Send size={14} /> Send test</Button>
            <Button variant="ghost" onClick={() => void save("")}>Remove webhook</Button>
          </>
        ) : null}
        {message ? <span className={`text-[13px] ${message.ok ? "text-good" : "text-bad"}`}>{message.text}</span> : null}
      </div>
    </Card>
  );
}

export default function AlertsPage() {
  const { data: rules, refresh, error } = useApi<AlertRule[]>("/api/alerts");
  const { data: history, refresh: refreshHistory } = useApi<AlertHistoryEntry[]>("/api/alerts/history");
  const { data: datasets } = useApi<Dataset[]>("/api/datasets");
  const { data: metrics } = useApi<Metric[]>("/api/metrics");
  const [checking, setChecking] = useState(false);

  useLiveUpdates((update) => {
    if (update.alert) {
      void refresh();
      void refreshHistory();
    }
  });

  const act = async (id: string, action: "pause" | "resume" | "check") => {
    await api(`/api/alerts/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
    void refresh();
    void refreshHistory();
  };

  const checkAll = async () => {
    setChecking(true);
    try {
      await Promise.all((rules ?? []).filter((r) => r.enabled).map((r) => act(r.id, "check")));
    } finally {
      setChecking(false);
    }
  };

  const remove = async (id: string) => {
    await api(`/api/alerts/${id}`, { method: "DELETE" });
    void refresh();
  };

  return (
    <div className="max-w-5xl mx-auto px-4 md:px-8 py-8 space-y-5">
      <PageHeader
        title="Alerts"
        subtitle="Rules are checked whenever data arrives, and on a timer. Each problem is reported once, and again only when a new period breaks the rule."
        actions={rules?.length ? <Button busy={checking} onClick={() => void checkAll()}><RefreshCw size={14} /> Check all now</Button> : null}
      />
      {error ? <Note tone="bad">{error}</Note> : null}
      {!rules || !datasets || !metrics ? <Spinner /> : (
        <>
          <Card className="p-5">
            <h2 className="font-semibold mb-2">Rules</h2>
            {rules.length === 0 ? (
              <Empty title="No alerts yet">Create one below. Saved metrics on the Metrics page make good things to watch.</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {rules.map((rule) => {
                  const status = rule.enabled ? STATUS[rule.status] : { label: "Paused", className: "text-ink-3", icon: Pause };
                  const Icon = status.icon;
                  return (
                    <li key={rule.id} className="py-3 flex items-start gap-3">
                      <Icon size={17} className={`mt-0.5 shrink-0 ${status.className}`} aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium flex flex-wrap items-center gap-2">{rule.name} <span className={`text-[12px] font-medium ${status.className}`}>{status.label}</span></p>
                        <p className="text-[12.5px] text-ink-2">When {describeRule(rule, metrics)}</p>
                        {rule.message ? <p className="text-[12.5px] mt-0.5">{rule.message}</p> : null}
                        <p className="text-[12px] text-ink-3 mt-0.5">{rule.lastCheckedAt ? `Checked ${timeAgo(rule.lastCheckedAt)}` : "Not checked yet"}{rule.lastFiredAt ? ` · last fired ${timeAgo(rule.lastFiredAt)}` : ""}</p>
                      </div>
                      <div className="flex items-center shrink-0">
                        <Button size="sm" variant="ghost" aria-label="Check now" title="Check now" disabled={!rule.enabled} onClick={() => void act(rule.id, "check")}><RefreshCw size={13} /></Button>
                        {rule.enabled ? (
                          <Button size="sm" variant="ghost" aria-label="Pause" title="Pause" onClick={() => void act(rule.id, "pause")}><Pause size={13} /></Button>
                        ) : (
                          <Button size="sm" variant="ghost" aria-label="Resume" title="Resume" onClick={() => void act(rule.id, "resume")}><Play size={13} /></Button>
                        )}
                        <Button size="sm" variant="ghost" aria-label={`Delete ${rule.name}`} onClick={() => void remove(rule.id)}><Trash2 size={13} /></Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <div className="grid lg:grid-cols-[1fr_380px] gap-5 items-start">
            <Card className="p-5">
              <h2 className="font-semibold mb-3">New alert</h2>
              {datasets.length === 0 ? <p className="text-ink-2">Add data first.</p> : <NewAlert datasets={datasets} metrics={metrics} onCreated={() => { void refresh(); void refreshHistory(); }} />}
            </Card>
            <Notifications />
          </div>
          <Card className="p-5">
            <h2 className="font-semibold mb-2">History</h2>
            {!history?.length ? <p className="text-ink-2">Nothing has fired yet.</p> : (
              <ul className="divide-y divide-line">
                {history.map((entry) => (
                  <li key={entry.id} className="py-2.5 flex items-start gap-3">
                    <Badge tone={entry.status === "firing" ? "accent" : "neutral"}>{entry.status === "firing" ? "Fired" : entry.status === "resolved" ? "Cleared" : "Error"}</Badge>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px]"><span className="font-medium">{entry.alertName}</span>: {entry.message}</p>
                      <p className="text-[12px] text-ink-3">
                        {new Date(entry.at).toLocaleString()} · {entry.delivery === "sent" ? "sent to webhook" : entry.delivery === "failed" ? `webhook failed${entry.deliveryDetail ? `: ${entry.deliveryDetail}` : ""}` : "shown here only"}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

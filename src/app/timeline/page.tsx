"use client";

import { ArrowDownRight, ArrowUpRight, CalendarSearch, MessageSquare, Plus, Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChartCard } from "@/components/charts/ChartCard";
import { Badge, Button, Card, Empty, Field, inputClass, Note, PageHeader, Select, Spinner } from "@/components/ui";
import { api, post, useApi } from "@/lib/client";
import { compact, exactValue, formatTick, humanize } from "@/lib/format";
import type { Anomaly, ChartPayload, Dataset, EventCategory, EventImpact, EventNote, Grain, PeriodExplanation, SegmentAnomaly, TimelineResult } from "@/lib/types";

const CATEGORIES: { value: EventCategory; label: string }[] = [
  { value: "promotion", label: "Promotion" },
  { value: "incident", label: "Incident" },
  { value: "release", label: "Release" },
  { value: "holiday", label: "Holiday" },
  { value: "pipeline", label: "Pipeline" },
  { value: "other", label: "Other" },
];

const VERDICT: Record<EventImpact["verdict"], string> = {
  clear: "Clear change",
  weak: "Possible change",
  none: "No clear change",
  insufficient: "Not enough data",
};

const isDate = (type: string) => type === "date" || type === "datetime";
const isNumber = (type: string) => type === "integer" || type === "number";
const percent = (value: number | null) => (value === null ? "" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(0)}%`);

interface Query {
  table: string;
  dateColumn: string;
  valueColumn: string | null;
  agg: "sum" | "avg" | "count";
  grain: Grain | null;
}

function Explanation({ query, result }: { query: Query; result: PeriodExplanation }) {
  const widest = Math.max(...result.movers.map((m) => Math.abs(m.change)), 1);
  const ask = `What happened to ${query.valueColumn ?? "rows"} in ${query.table} on ${result.date}?`;
  return (
    <Card className="p-4 rise">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{formatTick(result.date)}</h2>
          <p className="text-[12.5px] text-ink-2">
            {result.label}: <span className="tnum font-medium text-ink">{exactValue(result.value, undefined)}</span>
            {result.baseline !== null ? <> against a usual <span className="tnum">{exactValue(result.baseline, undefined)}</span> ({percent(result.changePct)})</> : " with no comparable periods"}
          </p>
          {result.comparedWith.length ? (
            <p className="text-[12px] text-ink-3 mt-0.5">Usual means the average of {result.comparedWith.length} comparable {result.grain === "day" ? "same weekdays" : `${result.grain}s`} before it.</p>
          ) : null}
        </div>
        <Link href={`/chat?table=${query.table}&q=${encodeURIComponent(ask)}`}>
          <Button size="sm"><MessageSquare size={13} /> Ask Claude</Button>
        </Link>
      </div>
      {result.events.length ? (
        <ul className="mt-3 space-y-1 text-[13px]">
          {result.events.map((event) => (
            <li key={event.id} className="flex items-center gap-2"><Badge>{event.category}</Badge><span>{event.title}</span><span className="text-[12px] text-ink-3 tnum">{event.date}</span></li>
          ))}
        </ul>
      ) : null}
      {result.movers.length ? (
        <div className="mt-3">
          <p className="text-[12.5px] font-medium text-ink-2 mb-1.5">Where the change sits</p>
          <ul className="space-y-1.5">
            {result.movers.map((mover) => (
              <li key={`${mover.dimension}:${mover.segment}`} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_72px] items-center gap-2 text-[12.5px]">
                <span className="truncate"><span className="text-ink-3">{humanize(mover.dimension)}:</span> {mover.segment}</span>
                <span className="h-2 bg-surface-2 rounded-r overflow-hidden"><span className="block h-full rounded-r bg-[var(--series-1)]" style={{ width: `${(Math.abs(mover.change) / widest) * 100}%` }} /></span>
                <span className="tnum text-right text-ink-2">{mover.change >= 0 ? "+" : ""}{compact(mover.change)}</span>
              </li>
            ))}
          </ul>
          <p className="text-[12px] text-ink-3 mt-1.5">Each row is a separate view of the same change, so they overlap. This shows where it happened, not why.</p>
        </div>
      ) : null}
    </Card>
  );
}

function ImpactResult({ impact }: { impact: EventImpact }) {
  return (
    <div className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] rise">
      <p className="font-medium">{VERDICT[impact.verdict]}</p>
      {impact.before !== null && impact.after !== null ? (
        <p className="tnum text-ink-2">{compact(impact.before)} per {impact.grain} before, {compact(impact.after)} after ({percent(impact.changePct)}) over {impact.window} {impact.grain}s each side</p>
      ) : null}
      <p className="text-ink-2 mt-0.5">{impact.note}</p>
    </div>
  );
}

function EventRow({ event, query, onDelete }: { event: EventNote; query: Query | null; onDelete: () => void }) {
  const [impact, setImpact] = useState<EventImpact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const measure = async () => {
    if (!query) return;
    setBusy(true);
    setError(null);
    try {
      setImpact(await post<EventImpact>("/api/timeline/impact", { ...query, eventId: event.id }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="py-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-snug">{event.title}</p>
          <p className="text-[12px] text-ink-3 tnum">{event.date} · {event.category}{event.source === "stream" ? " · from a stream" : ""}{event.table ? ` · ${event.table}` : ""}</p>
          {event.detail ? <p className="text-[12.5px] text-ink-2 mt-0.5 break-words">{event.detail}</p> : null}
        </div>
        <Button size="sm" busy={busy} disabled={!query} onClick={() => void measure()}>Measure</Button>
        <Button size="sm" variant="ghost" aria-label={`Delete ${event.title}`} onClick={onDelete}><Trash2 size={13} /></Button>
      </div>
      {impact ? <ImpactResult impact={impact} /> : null}
      {error ? <div className="mt-2"><Note tone="bad">{error}</Note></div> : null}
    </li>
  );
}

function AddEvent({ datasets, onAdded, preset }: { datasets: Dataset[]; onAdded: () => void; preset: string }) {
  const [date, setDate] = useState("");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [category, setCategory] = useState<EventCategory>("promotion");
  const [table, setTable] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (preset) setDate(preset);
  }, [preset]);

  const save = async () => {
    setError(null);
    try {
      await post("/api/events", { date, title, detail: detail || undefined, category, table: table || null });
      setTitle("");
      setDetail("");
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Date"><input type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Type"><Select value={category} onChange={(v) => setCategory(v as EventCategory)} options={CATEGORIES} /></Field>
      </div>
      <Field label="What happened"><input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Summer sale started" /></Field>
      <Field label="Details (optional)"><input className={inputClass} value={detail} onChange={(e) => setDetail(e.target.value)} /></Field>
      <Field label="Applies to">
        <Select value={table} onChange={setTable} options={[{ value: "", label: "All tables" }, ...datasets.map((d) => ({ value: d.id, label: d.id }))]} />
      </Field>
      {error ? <Note tone="bad">{error}</Note> : null}
      <Button variant="primary" disabled={!date || !title.trim()} onClick={() => void save()}><Plus size={14} /> Add event</Button>
    </div>
  );
}

function AnomalyRow({ anomaly, active, onPick }: { anomaly: Anomaly | SegmentAnomaly; active: boolean; onPick: () => void }) {
  const Icon = anomaly.direction === "spike" ? ArrowUpRight : ArrowDownRight;
  const where = "segment" in anomaly ? `${humanize(anomaly.dimension)}: ${anomaly.segment}` : null;
  return (
    <li>
      <button type="button" onClick={onPick} aria-pressed={active} className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left cursor-pointer ${active ? "bg-accent-soft" : "hover:bg-surface-2"}`}>
        <Icon size={15} className="shrink-0 text-ink-2" aria-label={anomaly.direction} />
        <span className="tnum font-medium">{anomaly.date}</span>
        {where ? <span className="text-[12.5px] text-ink-2 truncate">{where}</span> : null}
        <span className="ml-auto tnum text-[12.5px] text-ink-2 shrink-0">{compact(anomaly.value)} vs {compact(anomaly.expected)}</span>
        <span className="tnum text-[12.5px] w-12 text-right">{percent(anomaly.changePct)}</span>
      </button>
    </li>
  );
}

export default function TimelinePage() {
  const { data: datasets, error: loadError } = useApi<Dataset[]>("/api/datasets");
  const { data: events, refresh: refreshEvents } = useApi<EventNote[]>("/api/events");
  const usable = useMemo(() => (datasets ?? []).filter((d) => d.columns.some((c) => isDate(c.type))), [datasets]);

  const [table, setTable] = useState("");
  const dataset = usable.find((d) => d.id === table);
  const dates = useMemo(() => dataset?.columns.filter((c) => isDate(c.type)) ?? [], [dataset]);
  const numbers = useMemo(() => dataset?.columns.filter((c) => isNumber(c.type)) ?? [], [dataset]);
  const [dateColumn, setDateColumn] = useState("");
  const [valueColumn, setValueColumn] = useState("");
  const [agg, setAgg] = useState<Query["agg"]>("sum");
  const [grain, setGrain] = useState<"" | Grain>("");
  const [output, setOutput] = useState<{ result: TimelineResult; chart: ChartPayload } | null>(null);
  const [ran, setRan] = useState<Query | null>(null);
  const [picked, setPicked] = useState<PeriodExplanation | null>(null);
  const [lookup, setLookup] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (table || usable.length === 0) return;
    const wanted = new URLSearchParams(window.location.search).get("table");
    setTable(usable.some((d) => d.id === wanted) ? wanted! : usable[0].id);
  }, [usable, table]);

  useEffect(() => {
    setDateColumn(dates[0]?.name ?? "");
    const preferred = numbers.find((c) => /revenue|sales|amount|total/i.test(c.name)) ?? numbers[numbers.length - 1];
    setValueColumn(preferred?.name ?? "");
    setAgg(preferred ? "sum" : "count");
  }, [dates, numbers]);

  const currentQuery = useCallback((): Query => ({ table, dateColumn, valueColumn: agg === "count" ? null : valueColumn, agg, grain: grain || null }), [table, dateColumn, valueColumn, agg, grain]);

  const run = useCallback(async () => {
    const query = currentQuery();
    setBusy(true);
    setError(null);
    setPicked(null);
    try {
      setOutput(await post("/api/timeline", query));
      setRan(query);
    } catch (e) {
      setOutput(null);
      setRan(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [currentQuery]);

  const explain = async (date: string) => {
    if (!ran) return;
    setError(null);
    try {
      setPicked(await post("/api/timeline/explain", { ...ran, date }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const eventsChanged = async () => {
    await refreshEvents();
    if (ran) void run();
  };

  const removeEvent = async (id: string) => {
    await api(`/api/events/${id}`, { method: "DELETE" });
    void eventsChanged();
  };

  return (
    <div className="max-w-6xl mx-auto px-4 md:px-8 py-8">
      <PageHeader title="Timeline" subtitle="See which days were unusual, what changed on them, and whether the things you logged made a difference." />
      {loadError ? <Note tone="bad">{loadError}</Note> : null}
      {!datasets ? <Spinner /> : usable.length === 0 ? (
        <Card><Empty title="No date columns yet" action={<Link href="/"><Button variant="primary">Add data</Button></Link>}>The timeline needs a table with a date column.</Empty></Card>
      ) : (
        <div className="space-y-4">
          <Card className="p-4">
            <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
              <Field label="Table"><Select value={table} onChange={setTable} options={usable.map((d) => ({ value: d.id, label: d.id }))} /></Field>
              <Field label="Date"><Select value={dateColumn} onChange={setDateColumn} options={dates.map((c) => ({ value: c.name, label: c.name }))} /></Field>
              <Field label="Measure"><Select value={agg} onChange={(v) => setAgg(v as Query["agg"])} options={[{ value: "sum", label: "Sum of" }, { value: "avg", label: "Average of" }, { value: "count", label: "Count of rows" }]} /></Field>
              <Field label="Value"><Select value={valueColumn} disabled={agg === "count"} onChange={setValueColumn} options={numbers.map((c) => ({ value: c.name, label: c.name }))} /></Field>
              <Field label="Period"><Select value={grain} onChange={(v) => setGrain(v as typeof grain)} options={[{ value: "", label: "Auto" }, { value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }, { value: "quarter", label: "Quarter" }]} /></Field>
            </div>
            <Button className="mt-3" variant="primary" busy={busy} disabled={!dateColumn || (agg !== "count" && !valueColumn)} onClick={() => void run()}>
              <Sparkles size={14} /> Find what happened
            </Button>
          </Card>
          {error ? <Note tone="bad" onClose={() => setError(null)}>{error}</Note> : null}
          {output ? (
            <>
              <ChartCard payload={output.chart} height={300} />
              {output.result.warnings.map((warning) => <Note key={warning}>{warning}</Note>)}
            </>
          ) : null}
          <div className="grid lg:grid-cols-[1fr_340px] gap-4 items-start">
            <div className="space-y-4 min-w-0">
              {output ? (
                <Card className="p-4">
                  <h2 className="font-semibold">Unusual {output.result.grain}s</h2>
                  <p className="text-[12.5px] text-ink-2 mb-2">Far from what the trend and usual pattern predict. Select one to see what changed.</p>
                  {output.result.anomalies.length === 0 ? <p className="text-ink-2">Nothing stands out.</p> : (
                    <ul className="max-h-72 overflow-y-auto">
                      {output.result.anomalies.map((anomaly) => <AnomalyRow key={anomaly.date} anomaly={anomaly} active={picked?.date === anomaly.date} onPick={() => void explain(anomaly.date)} />)}
                    </ul>
                  )}
                  {output.result.segments.length ? (
                    <div className="mt-3 pt-3 border-t border-line">
                      <h3 className="font-medium">Hidden inside a segment</h3>
                      <p className="text-[12.5px] text-ink-2 mb-2">Unusual for this group, even where the overall number looked normal.</p>
                      <ul>
                        {output.result.segments.map((anomaly) => <AnomalyRow key={`${anomaly.dimension}:${anomaly.segment}:${anomaly.date}`} anomaly={anomaly} active={picked?.date === anomaly.date} onPick={() => void explain(anomaly.date)} />)}
                      </ul>
                    </div>
                  ) : null}
                  <div className="mt-3 pt-3 border-t border-line flex items-end gap-2">
                    <Field label="Or look up any date"><input type="date" className={inputClass} value={lookup} onChange={(e) => setLookup(e.target.value)} /></Field>
                    <Button disabled={!lookup} onClick={() => void explain(lookup)}><CalendarSearch size={14} /> Look up</Button>
                  </div>
                </Card>
              ) : null}
              {picked && ran ? <Explanation query={ran} result={picked} /> : null}
            </div>
            <div className="space-y-4">
              <Card className="p-4">
                <h2 className="font-semibold mb-2">Log an event</h2>
                <AddEvent datasets={datasets} onAdded={() => void eventsChanged()} preset={picked?.date ?? ""} />
              </Card>
              {events?.length ? (
                <Card className="p-4">
                  <h2 className="font-semibold">Logged events</h2>
                  {!ran ? <p className="text-[12.5px] text-ink-2 mt-0.5">Run the timeline above to measure their effect.</p> : null}
                  <ul className="divide-y divide-line max-h-[480px] overflow-y-auto">
                    {events.slice(0, 50).map((event) => <EventRow key={event.id} event={event} query={ran} onDelete={() => void removeEvent(event.id)} />)}
                  </ul>
                </Card>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

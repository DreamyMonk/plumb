"use client";

import { Check, Link2, Plus, Sparkles, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Empty, Field, inputClass, Note, PageHeader, Select, Spinner } from "@/components/ui";
import { api, post, useApi } from "@/lib/client";
import { exactValue, formatValue } from "@/lib/format";
import type { Dataset, Metric, MetricSuggestion, TableLink, ValueFormat } from "@/lib/types";

type MetricRow = Metric & { value: number | null; error?: string };

const AGGREGATES = [
  { value: "SUM", label: "Sum of" },
  { value: "AVG", label: "Average of" },
  { value: "COUNT", label: "Count of rows" },
  { value: "COUNT_DISTINCT", label: "Count of distinct" },
  { value: "MIN", label: "Smallest" },
  { value: "MAX", label: "Largest" },
];

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

function buildExpression(aggregate: string, column: string, filter: string): string {
  const core = aggregate === "COUNT" ? "COUNT(*)" : aggregate === "COUNT_DISTINCT" ? `COUNT(DISTINCT ${quote(column)})` : `${aggregate}(${quote(column)})`;
  return filter.trim() ? `${core} FILTER (WHERE ${filter.trim()})` : core;
}

function MetricForm({ datasets, preset, onSaved }: { datasets: Dataset[]; preset: { table: string; suggestion?: MetricSuggestion } | null; onSaved: () => void }) {
  const [table, setTable] = useState(datasets[0]?.id ?? "");
  const dataset = datasets.find((d) => d.id === table);
  const numeric = useMemo(() => dataset?.columns.filter((c) => c.type === "integer" || c.type === "number") ?? [], [dataset]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [aggregate, setAggregate] = useState("SUM");
  const [column, setColumn] = useState("");
  const [filter, setFilter] = useState("");
  const [custom, setCustom] = useState(false);
  const [expression, setExpression] = useState("");
  const [format, setFormat] = useState<ValueFormat>("number");
  const [currency, setCurrency] = useState("");
  const [preview, setPreview] = useState<{ value: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!preset) return;
    setTable(preset.table);
    if (preset.suggestion) {
      setName(preset.suggestion.name);
      setDescription(preset.suggestion.description);
      setCustom(true);
      setExpression(preset.suggestion.expression);
      setFormat(preset.suggestion.format ?? "number");
    }
  }, [preset]);

  useEffect(() => {
    setColumn((current) => (numeric.some((c) => c.name === current) ? current : (numeric[0]?.name ?? "")));
  }, [numeric]);

  const finalExpression = custom ? expression : buildExpression(aggregate, column, filter);

  const check = async () => {
    setError(null);
    try {
      setPreview(await post<{ value: number | null }>("/api/metrics/preview", { table, expression: finalExpression }));
    } catch (e) {
      setPreview(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await post("/api/metrics", { name, description: description || undefined, table, expression: finalExpression, format, currency: format === "currency" ? currency || undefined : undefined });
      setName("");
      setDescription("");
      setFilter("");
      setExpression("");
      setPreview(null);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Name"><input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Net revenue" /></Field>
        <Field label="Table"><Select value={table} onChange={(v) => { setTable(v); setPreview(null); }} options={datasets.map((d) => ({ value: d.id, label: d.id }))} /></Field>
      </div>
      {custom ? (
        <Field label="Calculation (SQL)" hint="Must give one number for the whole table, like SUM(revenue) FILTER (WHERE NOT returned).">
          <textarea className={`${inputClass} h-20 py-2 font-mono text-[12.5px]`} value={expression} onChange={(e) => { setExpression(e.target.value); setPreview(null); }} />
        </Field>
      ) : (
        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="Calculation"><Select value={aggregate} onChange={(v) => { setAggregate(v); setPreview(null); }} options={AGGREGATES} /></Field>
          <Field label="Column"><Select value={column} disabled={aggregate === "COUNT"} onChange={(v) => { setColumn(v); setPreview(null); }} options={numeric.map((c) => ({ value: c.name, label: c.name }))} /></Field>
          <Field label="Only rows where (optional)"><input className={`${inputClass} font-mono text-[12.5px]`} value={filter} onChange={(e) => { setFilter(e.target.value); setPreview(null); }} placeholder="NOT returned" /></Field>
        </div>
      )}
      <button type="button" className="text-[12.5px] text-accent underline cursor-pointer" onClick={() => { if (!custom) setExpression(finalExpression); setCustom(!custom); }}>
        {custom ? "Use the simple builder" : "Write the SQL myself"}
      </button>
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label="Description (optional)"><input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Show as"><Select value={format} onChange={(v) => setFormat(v as ValueFormat)} options={[{ value: "number", label: "Number" }, { value: "currency", label: "Money" }, { value: "percent", label: "Percent (0-100)" }]} /></Field>
        {format === "currency" ? <Field label="Currency symbol"><input className={inputClass} value={currency} onChange={(e) => setCurrency(e.target.value)} placeholder="$" maxLength={4} /></Field> : null}
      </div>
      <p className="text-[12px] text-ink-3 font-mono break-all">{finalExpression}</p>
      {error ? <Note tone="bad">{error}</Note> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void check()} disabled={!finalExpression.trim()}>Check</Button>
        <Button variant="primary" busy={busy} disabled={!name.trim() || !finalExpression.trim()} onClick={() => void save()}><Plus size={14} /> Save metric</Button>
        {preview ? <span className="text-[13px] tnum"><Check size={13} className="inline text-good -mt-0.5" aria-hidden /> Currently {exactValue(preview.value, format, currency || undefined)}</span> : null}
      </div>
    </div>
  );
}

function LinkForm({ datasets, onSaved }: { datasets: Dataset[]; onSaved: () => void }) {
  const [fromTable, setFromTable] = useState(datasets[0]?.id ?? "");
  const [toTable, setToTable] = useState(datasets[1]?.id ?? datasets[0]?.id ?? "");
  const columns = (id: string) => datasets.find((d) => d.id === id)?.columns.filter((c) => c.type === "text" || c.type === "integer") ?? [];
  const [fromColumn, setFromColumn] = useState("");
  const [toColumn, setToColumn] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setFromColumn(columns(fromTable)[0]?.name ?? ""), [fromTable]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setToColumn(columns(toTable)[0]?.name ?? ""), [toTable]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setError(null);
    try {
      await post("/api/links", { fromTable, fromColumn, toTable, toColumn });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid sm:grid-cols-4 gap-3">
        <Field label="From table"><Select value={fromTable} onChange={setFromTable} options={datasets.map((d) => ({ value: d.id, label: d.id }))} /></Field>
        <Field label="Column"><Select value={fromColumn} onChange={setFromColumn} options={columns(fromTable).map((c) => ({ value: c.name, label: c.name }))} /></Field>
        <Field label="To table"><Select value={toTable} onChange={setToTable} options={datasets.map((d) => ({ value: d.id, label: d.id }))} /></Field>
        <Field label="Column (one row each)"><Select value={toColumn} onChange={setToColumn} options={columns(toTable).map((c) => ({ value: c.name, label: c.name }))} /></Field>
      </div>
      {error ? <Note tone="bad">{error}</Note> : null}
      <Button onClick={() => void save()} disabled={!fromColumn || !toColumn || fromTable === toTable}><Link2 size={14} /> Add link</Button>
    </div>
  );
}

export default function MetricsPage() {
  const { data: datasets } = useApi<Dataset[]>("/api/datasets");
  const { data: metricList, refresh: refreshMetrics, error: metricError } = useApi<MetricRow[]>("/api/metrics");
  const { data: links, refresh: refreshLinks } = useApi<TableLink[]>("/api/links");
  const [suggestTable, setSuggestTable] = useState("");
  const [suggestions, setSuggestions] = useState<MetricSuggestion[] | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [preset, setPreset] = useState<{ table: string; suggestion?: MetricSuggestion } | null>(null);
  const [showLinkForm, setShowLinkForm] = useState(false);

  useEffect(() => {
    if (!suggestTable && datasets?.length) setSuggestTable(datasets[0].id);
  }, [datasets, suggestTable]);

  const suggest = async () => {
    setSuggesting(true);
    setSuggestError(null);
    try {
      setSuggestions(await post<MetricSuggestion[]>("/api/metrics/suggest", { table: suggestTable }));
    } catch (e) {
      setSuggestError(e instanceof Error ? e.message : String(e));
    } finally {
      setSuggesting(false);
    }
  };

  const remove = async (id: string) => {
    await api(`/api/metrics/${id}`, { method: "DELETE" });
    void refreshMetrics();
  };

  const dismiss = async (id: string) => {
    await post("/api/links/dismiss", { id });
    void refreshLinks();
  };

  if (!datasets) return <Spinner />;
  if (datasets.length === 0) {
    return (
      <div className="max-w-5xl mx-auto px-4 md:px-8 py-8">
        <PageHeader title="Metrics" />
        <Card><Empty title="No data yet" action={<Link href="/"><Button variant="primary">Add data</Button></Link>}>Add a table to define metrics on it.</Empty></Card>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 md:px-8 py-8 space-y-5">
      <PageHeader title="Metrics" subtitle="Define each number once. The AI, dashboards, forecasts and alerts all use the same definition, so answers agree." />

      <Card className="p-5">
        <h2 className="font-semibold mb-3">Your metrics</h2>
        {metricError ? <Note tone="bad">{metricError}</Note> : null}
        {!metricList ? <Spinner /> : metricList.length === 0 ? (
          <p className="text-ink-2">None yet. Add one below, or ask the AI for suggestions.</p>
        ) : (
          <ul className="divide-y divide-line">
            {metricList.map((metric) => (
              <li key={metric.id} className="py-3 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium flex items-center gap-2">{metric.name} <Badge>{metric.table}</Badge></p>
                  {metric.description ? <p className="text-[12.5px] text-ink-2">{metric.description}</p> : null}
                  <p className="text-[12px] text-ink-3 font-mono break-all mt-0.5">{metric.expression}</p>
                  {metric.error ? <p className="text-[12.5px] text-bad mt-1">{metric.error}</p> : null}
                </div>
                <p className="text-[20px] font-semibold tracking-tight tnum shrink-0">{metric.error ? "–" : formatValue(metric.value, metric.format, metric.currency)}</p>
                <Button size="sm" variant="ghost" aria-label={`Delete ${metric.name}`} onClick={() => void remove(metric.id)}><Trash2 size={13} /></Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid lg:grid-cols-[1fr_340px] gap-5 items-start">
        <Card className="p-5">
          <h2 className="font-semibold mb-3">New metric</h2>
          <MetricForm key={preset ? `${preset.table}:${preset.suggestion?.name}` : "blank"} datasets={datasets} preset={preset} onSaved={() => { setPreset(null); void refreshMetrics(); }} />
        </Card>
        <Card className="p-5">
          <h2 className="font-semibold flex items-center gap-1.5"><Sparkles size={14} className="text-accent" aria-hidden /> Suggestions</h2>
          <p className="text-[12.5px] text-ink-2 mb-3">The AI proposes metrics for a table. Each one is run on your data first, and only those that work are shown.</p>
          <div className="flex gap-2">
            <Select value={suggestTable} onChange={(v) => { setSuggestTable(v); setSuggestions(null); }} options={datasets.map((d) => ({ value: d.id, label: d.id }))} />
            <Button busy={suggesting} onClick={() => void suggest()}>Suggest</Button>
          </div>
          {suggestError ? <div className="mt-3"><Note tone="bad">{suggestError}</Note></div> : null}
          {suggestions?.length === 0 ? <p className="mt-3 text-ink-2">No working suggestions this time.</p> : null}
          <ul className="mt-2 divide-y divide-line">
            {suggestions?.map((s) => (
              <li key={s.name} className="py-2.5">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{s.name} <span className="tnum text-ink-2 font-normal">· {formatValue(s.value, s.format ?? undefined)}</span></p>
                    <p className="text-[12.5px] text-ink-2">{s.description}</p>
                  </div>
                  <Button size="sm" onClick={() => setPreset({ table: suggestTable, suggestion: s })}>Use</Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">Links between tables</h2>
            <p className="text-[12.5px] text-ink-2">Found by matching ID columns. The AI joins tables only along these, so a metric can be split by a column in another table.</p>
          </div>
          <Button size="sm" onClick={() => setShowLinkForm(!showLinkForm)}>{showLinkForm ? "Cancel" : "Add link"}</Button>
        </div>
        {showLinkForm ? <div className="mt-3 pt-3 border-t border-line"><LinkForm datasets={datasets} onSaved={() => { setShowLinkForm(false); void refreshLinks(); }} /></div> : null}
        {!links ? <Spinner /> : links.length === 0 ? (
          <p className="mt-3 text-ink-2">No links found between your tables.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {links.map((link) => (
              <li key={link.id} className="py-2.5 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[13px] break-all">{link.fromTable}.{link.fromColumn} → {link.toTable}.{link.toColumn}</p>
                  <p className="text-[12.5px] text-ink-2 tnum">
                    {link.cardinality === "many-to-one" ? "Many rows to one" : "One to one"} · {Math.round(link.coverage * 100)}% of values match
                    {link.orphans ? ` · ${link.orphans.toLocaleString()} rows have no match` : ""}
                    {link.source === "user" ? " · added by you" : ""}
                  </p>
                </div>
                <Button size="sm" variant="ghost" aria-label="Remove link" title="Remove link" onClick={() => void dismiss(link.id)}><X size={13} /></Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

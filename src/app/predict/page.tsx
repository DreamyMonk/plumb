"use client";

import { AlertTriangle, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChartCard } from "@/components/charts/ChartCard";
import { ModelResult, WhatIf } from "@/components/ModelCard";
import { Button, Card, Empty, Field, Note, PageHeader, Select, Spinner, Tabs } from "@/components/ui";
import { post, useApi } from "@/lib/client";
import { compact } from "@/lib/format";
import type { ChartPayload, Dataset, ForecastResult, Grain, ModelSummary } from "@/lib/types";

type Mode = "forecast" | "outcome";

const isDate = (type: string) => type === "date" || type === "datetime";
const isNumber = (type: string) => type === "integer" || type === "number";

function Accuracy({ result }: { result: ForecastResult }) {
  const betterBy = Math.round(result.skill * 100);
  return (
    <Card className="p-4 space-y-3">
      <div>
        <p className="text-[12.5px] text-ink-2">Backtested accuracy</p>
        <p className="text-[24px] font-semibold tracking-tight">{result.mape !== null ? `±${(result.mape * 100).toFixed(1)}%` : `±${compact(result.mae)}`}</p>
        <p className="text-[12.5px] text-ink-3">Average miss on {result.testPoints} past periods it had not seen.</p>
      </div>
      <div>
        <p className="text-[12.5px] text-ink-2">Against a simple baseline</p>
        <p className="font-medium">{betterBy > 0 ? `${betterBy}% lower error` : "No improvement"}</p>
        <p className="text-[12.5px] text-ink-3">Baseline: repeating the recent past.</p>
      </div>
      <div>
        <p className="text-[12.5px] text-ink-2 mb-1">Methods compared</p>
        <ol className="space-y-0.5 text-[12.5px]">
          {result.candidates.map((candidate) => (
            <li key={candidate.model} className="flex justify-between gap-3">
              <span className={candidate.model === result.model ? "font-medium" : "text-ink-2"}>{candidate.label}</span>
              <span className="tnum text-ink-3">{compact(candidate.mae)}</span>
            </li>
          ))}
        </ol>
        <p className="text-[12px] text-ink-3 mt-1">Average error, lowest wins.</p>
      </div>
    </Card>
  );
}

function ForecastPanel({ datasets, initial }: { datasets: Dataset[]; initial: string }) {
  const usable = datasets.filter((d) => d.columns.some((c) => isDate(c.type)));
  const [table, setTable] = useState(usable.some((d) => d.id === initial) ? initial : (usable[0]?.id ?? ""));
  const dataset = usable.find((d) => d.id === table);
  const dates = useMemo(() => dataset?.columns.filter((c) => isDate(c.type)) ?? [], [dataset]);
  const numbers = useMemo(() => dataset?.columns.filter((c) => isNumber(c.type)) ?? [], [dataset]);
  const [dateColumn, setDateColumn] = useState("");
  const [valueColumn, setValueColumn] = useState("");
  const [agg, setAgg] = useState<"sum" | "avg" | "count">("sum");
  const [grain, setGrain] = useState<"" | Grain>("");
  const [horizon, setHorizon] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<{ result: ForecastResult; chart: ChartPayload } | null>(null);

  useEffect(() => {
    setDateColumn(dates[0]?.name ?? "");
    const preferred = numbers.find((c) => /revenue|sales|amount|total/i.test(c.name)) ?? numbers[numbers.length - 1];
    setValueColumn(preferred?.name ?? "");
    setOutput(null);
  }, [dates, numbers]);

  if (usable.length === 0) return <Empty title="No date columns yet">Forecasting needs a table with a date column.</Empty>;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setOutput(await post("/api/predict/forecast", { table, dateColumn, valueColumn: agg === "count" ? null : valueColumn, agg, grain: grain || null, horizon: horizon ? Number(horizon) : null }));
    } catch (e) {
      setOutput(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="grid sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end">
          <Field label="Table"><Select value={table} onChange={setTable} options={usable.map((d) => ({ value: d.id, label: d.id }))} /></Field>
          <Field label="Date"><Select value={dateColumn} onChange={setDateColumn} options={dates.map((c) => ({ value: c.name, label: c.name }))} /></Field>
          <Field label="Measure"><Select value={agg} onChange={(v) => setAgg(v as typeof agg)} options={[{ value: "sum", label: "Sum of" }, { value: "avg", label: "Average of" }, { value: "count", label: "Count of rows" }]} /></Field>
          <Field label="Value"><Select value={valueColumn} disabled={agg === "count"} onChange={setValueColumn} options={numbers.map((c) => ({ value: c.name, label: c.name }))} /></Field>
          <Field label="Period"><Select value={grain} onChange={(v) => setGrain(v as typeof grain)} options={[{ value: "", label: "Auto" }, { value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }, { value: "quarter", label: "Quarter" }, { value: "year", label: "Year" }]} /></Field>
          <Field label="Periods ahead"><Select value={horizon} onChange={setHorizon} options={[{ value: "", label: "Auto" }, ...[3, 6, 12, 18, 24, 30, 60, 90].map((n) => ({ value: String(n), label: String(n) }))]} /></Field>
        </div>
        <Button className="mt-3" variant="primary" busy={busy} onClick={() => void run()} disabled={!dateColumn || (agg !== "count" && !valueColumn)}>
          <TrendingUp size={14} /> Forecast
        </Button>
      </Card>
      {error ? <Note tone="bad">{error}</Note> : null}
      {output ? (
        <div className="grid lg:grid-cols-[1fr_280px] gap-4 items-start rise">
          <div className="space-y-3 min-w-0">
            <ChartCard payload={output.chart} height={320} />
            {output.result.warnings.map((warning) => (
              <p key={warning} className="flex gap-1.5 text-[12.5px] text-warn"><AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />{warning}</p>
            ))}
          </div>
          <Accuracy result={output.result} />
        </div>
      ) : null}
    </div>
  );
}

function OutcomePanel({ datasets, initial }: { datasets: Dataset[]; initial: string }) {
  const [table, setTable] = useState(datasets.some((d) => d.id === initial) ? initial : (datasets[0]?.id ?? ""));
  const dataset = datasets.find((d) => d.id === table);
  const targets = useMemo(() => dataset?.columns.filter((c) => !isDate(c.type) && c.distinct > 1) ?? [], [dataset]);
  const [target, setTarget] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<ModelSummary | null>(null);

  useEffect(() => {
    setTarget(targets[targets.length - 1]?.name ?? "");
    setExcluded(new Set());
    setModel(null);
  }, [targets]);

  const candidates = dataset?.columns.filter((c) => c.name !== target && !isDate(c.type)) ?? [];

  const train = async () => {
    setBusy(true);
    setError(null);
    try {
      const features = excluded.size ? candidates.filter((c) => !excluded.has(c.name)).map((c) => c.name) : null;
      setModel(await post("/api/predict/train", { table, target, features }));
    } catch (e) {
      setModel(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="grid sm:grid-cols-2 gap-3 max-w-xl">
          <Field label="Table"><Select value={table} onChange={setTable} options={datasets.map((d) => ({ value: d.id, label: d.id }))} /></Field>
          <Field label="Column to predict"><Select value={target} onChange={setTarget} options={targets.map((c) => ({ value: c.name, label: c.name }))} /></Field>
        </div>
        <details className="mt-3">
          <summary className="cursor-pointer text-[13px] text-ink-2">Leave out columns</summary>
          <p className="text-[12.5px] text-ink-3 mt-1">Uncheck anything only known after the outcome. It would make the model look better than it is.</p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {candidates.map((column) => (
              <label key={column.name} className="flex items-center gap-1.5 text-[13px] cursor-pointer">
                <input
                  type="checkbox"
                  checked={!excluded.has(column.name)}
                  onChange={(event) => {
                    const next = new Set(excluded);
                    if (event.target.checked) next.delete(column.name);
                    else next.add(column.name);
                    setExcluded(next);
                  }}
                />
                {column.name}
              </label>
            ))}
          </div>
        </details>
        <Button className="mt-3" variant="primary" busy={busy} disabled={!target} onClick={() => void train()}>Train model</Button>
      </Card>
      {error ? <Note tone="bad">{error}</Note> : null}
      {model ? (
        <div className="space-y-4 rise">
          <Card className="p-4"><ModelResult model={model} /></Card>
          <WhatIf key={model.id} model={model} />
        </div>
      ) : null}
    </div>
  );
}

export default function PredictPage() {
  const { data: datasets, error } = useApi<Dataset[]>("/api/datasets");
  const [mode, setMode] = useState<Mode>("forecast");
  const [initial, setInitial] = useState<string | null>(null);

  useEffect(() => {
    setInitial(new URLSearchParams(window.location.search).get("table") ?? "");
  }, []);

  return (
    <div className="max-w-6xl mx-auto px-4 md:px-8 py-8">
      <PageHeader title="Predict" subtitle="Accuracy here is measured on data the model has not seen, so you can judge how far to trust it." />
      {error ? <Note tone="bad">{error}</Note> : null}
      {!datasets || initial === null ? <Spinner /> : datasets.length === 0 ? (
        <Empty title="No data yet" action={<Link href="/"><Button variant="primary">Add data</Button></Link>}>Add a table to forecast or predict from it.</Empty>
      ) : (
        <>
          <Tabs<Mode> value={mode} onChange={setMode} tabs={[{ id: "forecast", label: "Forecast a trend" }, { id: "outcome", label: "Predict an outcome" }]} />
          {mode === "forecast" ? <ForecastPanel datasets={datasets} initial={initial} /> : <OutcomePanel datasets={datasets} initial={initial} />}
        </>
      )}
    </div>
  );
}

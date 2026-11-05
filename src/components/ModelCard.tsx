"use client";

import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { post } from "@/lib/client";
import { compact } from "@/lib/format";
import type { ModelSummary, PredictionResult } from "@/lib/types";
import { Button, Card, Field, inputClass, Note, Select } from "./ui";

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <p className="text-[12.5px] text-ink-2">{label}</p>
      <p className="text-[22px] font-semibold tracking-tight leading-tight">{value}</p>
      {note ? <p className="text-[12px] text-ink-3">{note}</p> : null}
    </div>
  );
}

export function ModelResult({ model }: { model: ModelSummary }) {
  const regression = model.task === "regression";
  const top = model.features.filter((f) => f.importance > 0).slice(0, 10);
  const max = Math.max(...top.map((f) => f.importance), 0.0001);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        {regression ? (
          <>
            <Metric label="R² on held-out rows" value={model.metrics.r2.toFixed(3)} note="1 is perfect, 0 is no better than the average" />
            <Metric label="Typical error" value={compact(model.metrics.mae)} note={`Guessing the average: ${compact(model.baseline.mae)}`} />
            <Metric label="Tested on" value={model.rowsTested.toLocaleString()} note={`Trained on ${model.rowsTrained.toLocaleString()} rows`} />
          </>
        ) : (
          <>
            <Metric label="Accuracy on held-out rows" value={pct(model.metrics.accuracy)} note={`Always guessing the commonest: ${pct(model.baseline.accuracy)}`} />
            {model.metrics.auc !== undefined ? <Metric label="AUC" value={model.metrics.auc.toFixed(3)} note="0.5 is random, 1 is perfect" /> : <Metric label="Macro F1" value={model.metrics.f1.toFixed(3)} />}
            <Metric label="Tested on" value={model.rowsTested.toLocaleString()} note={`Trained on ${model.rowsTrained.toLocaleString()} rows`} />
          </>
        )}
      </div>
      {model.warnings.map((warning) => (
        <p key={warning} className="flex gap-1.5 text-[12.5px] text-warn"><AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />{warning}</p>
      ))}
      {top.length ? (
        <div>
          <p className="text-[12.5px] font-medium text-ink-2 mb-1.5">What helps the prediction most</p>
          <ul className="space-y-1">
            {top.map((feature) => (
              <li key={feature.name} className="grid grid-cols-[120px_1fr_44px] items-center gap-2 text-[12.5px]">
                <span className="truncate">{feature.name}</span>
                <span className="h-2 rounded-r bg-surface-2 overflow-hidden"><span className="block h-full rounded-r bg-[var(--series-1)]" style={{ width: `${(feature.importance / max) * 100}%` }} /></span>
                <span className="tnum text-right text-ink-2">{(feature.importance * 100).toFixed(0)}%</span>
              </li>
            ))}
          </ul>
          <p className="text-[12px] text-ink-3 mt-1.5">Importance shows what the model uses, not what causes the outcome.</p>
        </div>
      ) : null}
    </div>
  );
}

export function PredictionOutput({ result, target }: { result: PredictionResult; target: string }) {
  return (
    <div>
      <p className="text-[12.5px] text-ink-2">Predicted {target}</p>
      <p className="text-[24px] font-semibold tracking-tight">{typeof result.prediction === "number" ? compact(result.prediction) : result.prediction}</p>
      {result.low !== undefined ? <p className="text-[12.5px] text-ink-3 tnum">Likely between {compact(result.low)} and {compact(result.high ?? 0)}</p> : null}
      {result.probabilities ? (
        <ul className="mt-1 space-y-0.5 text-[12.5px] tnum">
          {result.probabilities.slice(0, 5).map((p) => (
            <li key={p.label} className="flex justify-between gap-4 max-w-48"><span className="text-ink-2 truncate">{p.label}</span><span>{(p.probability * 100).toFixed(1)}%</span></li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function WhatIf({ model }: { model: ModelSummary }) {
  const features = model.features.slice(0, 12);
  const initial = Object.fromEntries(features.map((f) => [f.name, f.type === "numeric" ? String(f.median ?? "") : (f.levels?.[0] ?? "")]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [result, setResult] = useState<PredictionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const input = Object.fromEntries(features.map((f) => [f.name, f.type === "numeric" ? (values[f.name] === "" ? null : Number(values[f.name])) : values[f.name]]));
      const { results } = await post<{ results: PredictionResult[] }>(`/api/predict/models/${model.id}`, { inputs: [input] });
      setResult(results[0]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4">
      <h3 className="font-semibold">Try a scenario</h3>
      <p className="text-[12.5px] text-ink-2 mb-3">Change the inputs to see the prediction. Columns not shown use typical values.</p>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {features.map((feature) => (
          <Field key={feature.name} label={feature.name}>
            {feature.type === "numeric" ? (
              <input className={`${inputClass} tnum`} type="number" value={values[feature.name]} onChange={(event) => setValues({ ...values, [feature.name]: event.target.value })} />
            ) : (
              <Select value={values[feature.name]} onChange={(value) => setValues({ ...values, [feature.name]: value })} options={(feature.levels ?? []).map((level) => ({ value: level, label: level }))} />
            )}
          </Field>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-6">
        <Button variant="primary" busy={busy} onClick={() => void run()}>Predict</Button>
        {result ? <PredictionOutput result={result} target={model.target} /> : null}
      </div>
      {error ? <div className="mt-3"><Note tone="bad">{error}</Note></div> : null}
    </Card>
  );
}

"use client";

import { AlertTriangle, ArrowRight, Check, Download, LayoutDashboard, MessageSquare, RotateCcw, ShieldCheck, Sparkles, Trash2, TrendingUp, Wand2 } from "lucide-react";
import Link from "next/link";
import { use, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Empty, inputClass, Note, PageHeader, Spinner, Tabs } from "@/components/ui";
import { api, notifyDatasets, post, useApi } from "@/lib/client";
import { compact } from "@/lib/format";
import { effectiveKind, PII_LABEL } from "@/lib/privacy/detect";
import type { CleanAction, ColumnProfile, Dataset, QualityScore, Row, Suggestion, TransformOp } from "@/lib/types";

type Tab = "clean" | "columns" | "rows";

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="flex justify-between text-[12.5px]">
        <span className="text-ink-2">{label}</span>
        <span className="tnum font-medium">{(value * 100).toFixed(1)}%</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-accent-soft overflow-hidden">
        <div className="h-full rounded-full bg-accent" style={{ width: `${value * 100}%` }} />
      </div>
    </div>
  );
}

function QualityPanel({ before, after, dataset }: { before: QualityScore; after: QualityScore; dataset: Dataset }) {
  const r = dataset.report;
  return (
    <Card className="p-4">
      <p className="text-[12.5px] font-medium text-ink-2">Quality score</p>
      <p className="mt-1 flex items-baseline gap-2">
        <span className="text-[17px] text-ink-3 tnum">{before.score}</span>
        <ArrowRight size={14} className="text-ink-3 self-center" aria-hidden />
        <span className="text-[36px] font-semibold tracking-tight leading-none">{after.score}</span>
        <span className="text-ink-3">/ 100</span>
      </p>
      <div className="mt-4 space-y-3">
        <Meter label="Completeness (cells with a value)" value={after.completeness} />
        <Meter label="Uniqueness (rows not duplicated)" value={after.uniqueness} />
        <Meter label="Consistency (cells in one format)" value={after.consistency} />
      </div>
      <dl className="mt-4 pt-3 border-t border-line grid grid-cols-2 gap-y-1 text-[12.5px] tnum">
        <dt className="text-ink-3">Rows</dt>
        <dd className="text-right">{r.rowsBefore.toLocaleString()} → {r.rowsAfter.toLocaleString()}</dd>
        <dt className="text-ink-3">Columns</dt>
        <dd className="text-right">{r.columnsBefore} → {r.columnsAfter}</dd>
        <dt className="text-ink-3">Cells changed</dt>
        <dd className="text-right">{r.cellsChanged.toLocaleString()}</dd>
      </dl>
    </Card>
  );
}

function ActionRow({ action }: { action: CleanAction }) {
  return (
    <li className="flex gap-2.5 py-2.5">
      {action.severity === "warn" ? <AlertTriangle size={15} className="mt-0.5 text-warn shrink-0" aria-label="Check this" /> : <Check size={15} className="mt-0.5 text-good shrink-0" aria-label="Done" />}
      <div className="min-w-0 flex-1">
        <p className="font-medium">{action.title}</p>
        {action.detail ? <p className="text-[12.5px] text-ink-2">{action.detail}</p> : null}
        {action.examples?.length ? <p className="text-[12px] text-ink-3 mt-0.5 break-words">{action.examples.join("  ·  ")}</p> : null}
      </div>
      <span className="tnum text-[12.5px] text-ink-3 shrink-0">{action.count.toLocaleString()}</span>
    </li>
  );
}

function describeStep(op: TransformOp): string {
  switch (op.op) {
    case "fill_missing":
      return `Filled missing ${op.column} (${op.strategy}${op.value ? `: ${op.value}` : ""})`;
    case "map_values":
      return `Corrected ${op.mapping.length} ${op.mapping.length === 1 ? "value" : "values"} in ${op.column}`;
    case "drop_column":
      return `Dropped ${op.column}`;
    case "rename_column":
      return `Renamed ${op.column} to ${op.newName}`;
    case "cast_type":
      return `Changed ${op.column} to ${op.to}`;
    case "drop_rows":
      return `Removed ${op.condition === "outlier" ? "outlier" : "blank"} rows in ${op.column}`;
  }
}

function SuggestionRow({ suggestion, onApply, disabled }: { suggestion: Suggestion; onApply: () => void; disabled: boolean }) {
  return (
    <li className="py-2.5 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium flex items-center gap-1.5">
          {suggestion.source === "ai" ? <Sparkles size={13} className="text-accent shrink-0" aria-label="Suggested by Claude" /> : null}
          {suggestion.title}
        </p>
        <p className="text-[12.5px] text-ink-2">{suggestion.reason}</p>
        {suggestion.transform.op === "map_values" ? (
          <p className="text-[12px] text-ink-3 mt-0.5 break-words">{suggestion.transform.mapping.map((m) => `${m.from} → ${m.to}`).join("  ·  ")}</p>
        ) : null}
      </div>
      <Button size="sm" onClick={onApply} disabled={disabled}>Apply</Button>
    </li>
  );
}

function CleaningTab({ dataset, onChange }: { dataset: Dataset; onChange: (next: Dataset) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (key: string, work: () => Promise<Dataset>) => {
    setBusy(key);
    setError(null);
    try {
      onChange(await work());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const actions = [...dataset.report.actions].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "warn" ? -1 : 1));

  return (
    <div className="grid lg:grid-cols-[280px_1fr] gap-4 items-start">
      <QualityPanel before={dataset.report.qualityBefore} after={dataset.report.qualityAfter} dataset={dataset} />
      <div className="space-y-4 min-w-0">
        {error ? <Note tone="bad" onClose={() => setError(null)}>{error}</Note> : null}
        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">Suggested fixes</h2>
              <p className="text-[12.5px] text-ink-2">Judgment calls. Nothing changes until you apply it, and you can undo.</p>
            </div>
            <Button busy={busy === "ai"} onClick={() => void act("ai", () => post(`/api/datasets/${dataset.id}/suggest`))}>
              <Wand2 size={14} /> Review with Claude
            </Button>
          </div>
          {dataset.description ? <p className="mt-3 text-[13px] text-ink-2 flex gap-1.5"><Sparkles size={13} className="mt-1 shrink-0 text-accent" aria-hidden />{dataset.description}</p> : null}
          {dataset.suggestions.length === 0 ? (
            <p className="mt-3 text-ink-2">No open suggestions.</p>
          ) : (
            <ul className="mt-1 divide-y divide-line">
              {dataset.suggestions.map((suggestion) => (
                <SuggestionRow key={suggestion.id} suggestion={suggestion} disabled={busy !== null} onApply={() => void act(suggestion.id, () => post(`/api/datasets/${dataset.id}/transform`, { transform: suggestion.transform }))} />
              ))}
            </ul>
          )}
        </Card>
        {dataset.steps.length > 0 ? (
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Applied by you</h2>
              <Button size="sm" busy={busy === "undo"} onClick={() => void act("undo", () => post(`/api/datasets/${dataset.id}/transform`, { undo: true }))}>
                <RotateCcw size={13} /> Undo last
              </Button>
            </div>
            <ol className="mt-2 space-y-1 text-[13px] text-ink-2 list-decimal pl-5">
              {dataset.steps.map((step, index) => (
                <li key={index}>{describeStep(step)}</li>
              ))}
            </ol>
          </Card>
        ) : null}
        <Card className="p-4">
          <h2 className="font-semibold">Cleaned automatically</h2>
          {actions.length === 0 ? <p className="mt-2 text-ink-2">This file was already clean.</p> : <ul className="divide-y divide-line">{actions.map((action, index) => <ActionRow key={index} action={action} />)}</ul>}
        </Card>
      </div>
    </div>
  );
}

function MiniHistogram({ column }: { column: ColumnProfile }) {
  const bins = column.histogram ?? [];
  if (bins.length < 2) return null;
  const max = Math.max(...bins.map((bin) => bin.count));
  return (
    <div>
      <div className="flex items-end gap-px h-12 mt-3" role="img" aria-label={`Distribution of ${column.name}`}>
        {bins.map((bin, index) => (
          <div key={index} title={`${bin.label}: ${bin.count.toLocaleString()}`} className="flex-1 rounded-t-[2px] bg-[var(--series-1)] min-h-px hover:opacity-70" style={{ height: `${(bin.count / max) * 100}%` }} />
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-ink-3 mt-1 tnum">
        <span>{bins[0].label}</span>
        <span>{bins[bins.length - 1].label}</span>
      </div>
    </div>
  );
}

function PrivacyControl({ dataset, column, onChange }: { dataset: Dataset; column: ColumnProfile; onChange: (next: Dataset) => void }) {
  const kind = effectiveKind(dataset, column);
  const override = dataset.privacy?.[column.name];
  const [busy, setBusy] = useState(false);
  const set = async (mode: "mask" | "allow" | "auto") => {
    setBusy(true);
    try {
      onChange(await post<Dataset>(`/api/datasets/${dataset.id}/privacy`, { column: column.name, mode }));
    } finally {
      setBusy(false);
    }
  };
  const detected = dataset.pii?.detected[column.name] ?? null;
  // Choosing what detection would do anyway just clears the override.
  const next = kind ? (detected ? "allow" : "auto") : detected ? "auto" : "mask";
  return (
    <div className="mt-2 flex items-center gap-2 text-[12px]">
      {kind ? (
        <span className="flex items-center gap-1 text-good" title="Claude sees tokens instead of these values">
          <ShieldCheck size={13} aria-hidden /> Masked for Claude · {PII_LABEL[kind]}
        </span>
      ) : (
        <span className="text-ink-3">{override === "allow" ? "Sent to Claude as is (your choice)" : "Sent to Claude as is"}</span>
      )}
      <button type="button" disabled={busy} onClick={() => void set(next)} className="ml-auto text-accent underline cursor-pointer disabled:opacity-50">
        {kind ? "Send as is" : "Mask"}
      </button>
    </div>
  );
}

function ColumnCard({ column, rows, privacy }: { column: ColumnProfile; rows: number; privacy?: ReactNode }) {
  const stats: [string, string][] = [];
  if (typeof column.mean === "number") stats.push(["Mean", compact(column.mean)], ["Median", compact(column.median ?? 0)]);
  if (typeof column.min === "number") stats.push(["Min", compact(column.min)], ["Max", compact(Number(column.max))]);
  if (typeof column.min === "string") stats.push(["From", column.min.slice(0, 10)], ["To", String(column.max).slice(0, 10)]);
  return (
    <Card className="p-3.5 min-w-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold font-mono text-[13px] truncate">{column.name}</p>
          {column.originalName !== column.name ? <p className="text-[12px] text-ink-3 truncate">{column.originalName}</p> : null}
        </div>
        <Badge>{column.type}{column.unit ? ` · ${column.unit}` : ""}</Badge>
      </div>
      <p className="mt-2 text-[12.5px] text-ink-2 tnum">
        {column.distinct.toLocaleString()} distinct · {column.nullCount === 0 ? "none missing" : `${(column.nullPct * 100).toFixed(1)}% missing`}
        {column.outliers ? ` · ${column.outliers} extreme` : ""}
      </p>
      {stats.length ? (
        <dl className="mt-2 grid grid-cols-2 gap-x-3 text-[12.5px] tnum">
          {stats.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-2">
              <dt className="text-ink-3">{label}</dt>
              <dd className="truncate">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {privacy}
      <MiniHistogram column={column} />
      {!column.histogram?.length && column.top?.length && column.distinct < rows * 0.9 ? (
        <ul className="mt-2 space-y-1">
          {column.top.slice(0, 5).map((top) => (
            <li key={top.value} className="relative text-[12.5px] flex justify-between gap-2 px-1.5 py-0.5 rounded overflow-hidden">
              <span className="absolute inset-y-0 left-0 bg-accent-soft" style={{ width: `${(top.count / Math.max(rows, 1)) * 100}%` }} aria-hidden />
              <span className="relative truncate">{top.value}</span>
              <span className="relative tnum text-ink-2">{top.count.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function RowsTab({ dataset }: { dataset: Dataset }) {
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ column: string; dir: "asc" | "desc" } | null>(null);
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const size = 50;

  useEffect(() => {
    const timer = setTimeout(() => {
      setTerm(search);
      setPage(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  const params = new URLSearchParams({ limit: String(size), offset: String(page * size) });
  if (sort) {
    params.set("sort", sort.column);
    params.set("dir", sort.dir);
  }
  if (term) params.set("q", term);
  const { data, error } = useApi<{ rows: Row[]; total: number }>(`/api/datasets/${dataset.id}/rows?${params}&v=${dataset.updatedAt}`);
  const total = data?.total ?? 0;
  const numeric = (name: string) => ["integer", "number"].includes(dataset.columns.find((c) => c.name === name)?.type ?? "");

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <input className={`${inputClass} max-w-64`} placeholder="Search text columns" aria-label="Search rows" value={search} onChange={(event) => setSearch(event.target.value)} />
        <span className="ml-auto text-[12.5px] text-ink-3 tnum">{total.toLocaleString()} rows</span>
        <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
        <Button size="sm" disabled={(page + 1) * size >= total} onClick={() => setPage(page + 1)}>Next</Button>
      </div>
      {error ? <Note tone="bad">{error}</Note> : null}
      <div className="overflow-auto rounded-xl border border-line bg-surface max-h-[65vh]">
        <table className="w-full text-[12.5px]">
          <thead className="sticky top-0 bg-surface-2 z-10">
            <tr>
              {dataset.columns.map((column) => {
                const active = sort?.column === column.name;
                return (
                  <th key={column.name} scope="col" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined} className={numeric(column.name) ? "text-right" : "text-left"}>
                    <button type="button" className="px-3 py-2 font-medium text-ink-2 whitespace-nowrap cursor-pointer hover:text-ink" onClick={() => setSort({ column: column.name, dir: active && sort.dir === "asc" ? "desc" : "asc" })}>
                      {column.name} {active ? (sort.dir === "asc" ? "↑" : "↓") : ""}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((row, index) => (
              <tr key={index} className="border-t border-line">
                {dataset.columns.map((column) => (
                  <td key={column.name} className={`px-3 py-1.5 whitespace-nowrap max-w-72 truncate ${numeric(column.name) ? "text-right tnum" : ""}`}>
                    {row[column.name] === null ? <span className="text-ink-3">–</span> : String(row[column.name])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function DatasetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data: dataset, setData, error, loading } = useApi<Dataset>(`/api/datasets/${id}`);
  const [tab, setTab] = useState<Tab>("clean");
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (loading && !dataset) return <Spinner />;
  if (error || !dataset) {
    return <Empty title="Dataset not found" action={<Link href="/"><Button>Back to data</Button></Link>}>{error}</Empty>;
  }

  const remove = async () => {
    setDeleting(true);
    await api(`/api/datasets/${id}`, { method: "DELETE" });
    notifyDatasets();
    router.push("/");
  };

  return (
    <div className="max-w-6xl mx-auto px-4 md:px-8 py-8">
      <PageHeader
        title={dataset.label}
        subtitle={<span className="tnum">{dataset.rowCount.toLocaleString()} rows · {dataset.columns.length} columns · from {dataset.source.name}</span>}
        actions={
          <>
            <Link href={`/chat?table=${id}`}><Button variant="primary"><MessageSquare size={14} /> Ask</Button></Link>
            <Link href={`/dashboards?table=${id}`}><Button><LayoutDashboard size={14} /> Dashboard</Button></Link>
            <Link href={`/predict?table=${id}`}><Button><TrendingUp size={14} /> Predict</Button></Link>
            <a href={`/api/datasets/${id}/export?format=csv`}><Button><Download size={14} /> CSV</Button></a>
            <a href={`/api/datasets/${id}/export?format=xlsx`}><Button><Download size={14} /> Excel</Button></a>
            {confirming ? (
              <Button variant="danger" busy={deleting} onClick={() => void remove()}>Confirm delete</Button>
            ) : (
              <Button variant="ghost" aria-label="Delete dataset" title="Delete dataset" onClick={() => setConfirming(true)}><Trash2 size={14} /></Button>
            )}
          </>
        }
      />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "clean", label: "Cleaning" },
          { id: "columns", label: "Columns" },
          { id: "rows", label: "Rows" },
        ]}
      />
      {tab === "clean" ? <CleaningTab dataset={dataset} onChange={(next) => { setData(next); notifyDatasets(); }} /> : null}
      {tab === "columns" ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {dataset.columns.map((column) => (
            <ColumnCard key={column.name} column={column} rows={dataset.rowCount} privacy={<PrivacyControl dataset={dataset} column={column} onChange={setData} />} />
          ))}
        </div>
      ) : null}
      {tab === "rows" ? <RowsTab dataset={dataset} /> : null}
    </div>
  );
}

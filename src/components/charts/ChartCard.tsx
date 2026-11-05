"use client";

import { BarChart3, Check, Download, Pin, Plus, Sparkles, Table2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, post } from "@/lib/client";
import { csvCell } from "@/lib/format";
import type { ChartPayload, Dashboard } from "@/lib/types";
import { Button, Note } from "../ui";
import { Chart, chartHeight } from "./Chart";
import { ResultTable } from "./ResultTable";

function downloadCsv(payload: ChartPayload) {
  const names = payload.columns.length ? payload.columns.map((c) => c.name) : Object.keys(payload.rows[0] ?? {});
  const csv = [names.join(","), ...payload.rows.map((row) => names.map((n) => csvCell(row[n])).join(","))].join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  link.download = `${payload.spec.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "chart"}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function PinButton({ payload }: { payload: ChartPayload }) {
  const [open, setOpen] = useState(false);
  const [boards, setBoards] = useState<Dashboard[] | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    api<Dashboard[]>("/api/dashboards").then(setBoards).catch((e) => setError(String(e.message)));
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const pin = async (board: Dashboard | null) => {
    try {
      const target = board ?? (await post<Dashboard>("/api/dashboards", { title: "My dashboard" }));
      await post(`/api/dashboards/${target.id}/widgets`, { spec: payload.spec, rows: payload.spec.sql ? undefined : payload.rows });
      setPinned(target.title);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="relative" ref={root}>
      <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open} title={pinned ? `Pinned to ${pinned}` : "Add to a dashboard"}>
        {pinned ? <Check size={13} /> : <Pin size={13} />}
        {pinned ? "Pinned" : "Pin"}
      </Button>
      {open ? (
        <div className="absolute right-0 top-8 z-30 w-56 rounded-lg border border-line bg-surface shadow-md py-1">
          {error ? <p className="px-3 py-1 text-[12px] text-bad">{error}</p> : null}
          {boards?.map((board) => (
            <button key={board.id} type="button" onClick={() => void pin(board)} className="block w-full text-left px-3 py-1.5 text-[13px] truncate hover:bg-surface-2 cursor-pointer">
              {board.title}
            </button>
          ))}
          <button type="button" onClick={() => void pin(null)} className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[13px] text-accent hover:bg-surface-2 cursor-pointer">
            <Plus size={13} /> New dashboard
          </button>
        </div>
      ) : null}
    </div>
  );
}

interface ChartCardProps {
  payload: ChartPayload;
  height?: number;
  actions?: ReactNode;
  pinnable?: boolean;
}

export function ChartCard({ payload, height = 260, actions, pinnable = true }: ChartCardProps) {
  const [showTable, setShowTable] = useState(false);
  const { spec, error, rows, columns } = payload;
  const isKpi = spec.type === "kpi";
  const tableOnly = spec.type === "table";
  const tableView = tableOnly || showTable;

  return (
    <section className="bg-surface border border-line rounded-xl p-4 h-full flex flex-col min-w-0 group">
      <header className="flex items-start gap-2 mb-2">
        <div className="min-w-0 flex-1">
          <h3 className={`${isKpi ? "text-[12.5px] font-medium text-ink-2" : "font-semibold text-[14px] leading-snug"}`}>{spec.title}</h3>
          {spec.subtitle && !isKpi ? <p className="text-[12.5px] text-ink-3 mt-0.5">{spec.subtitle}</p> : null}
        </div>
        <div className={`flex items-center -mr-1 -mt-1 ${isKpi ? "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity" : ""}`}>
          {!error && !isKpi && !tableOnly ? (
            <Button variant="ghost" size="sm" onClick={() => setShowTable(!showTable)} aria-label={showTable ? "Show chart" : "Show data table"} title={showTable ? "Show chart" : "Show data table"}>
              {showTable ? <BarChart3 size={13} /> : <Table2 size={13} />}
            </Button>
          ) : null}
          {!error && !isKpi ? (
            <Button variant="ghost" size="sm" onClick={() => downloadCsv(payload)} aria-label="Download CSV" title="Download CSV">
              <Download size={13} />
            </Button>
          ) : null}
          {!error && pinnable ? <PinButton payload={payload} /> : null}
          {actions}
        </div>
      </header>
      <div className="flex-1 min-h-0">
        {error ? (
          <Note tone="bad">This chart could not load: {error}</Note>
        ) : tableView ? (
          <ResultTable columns={columns} rows={rows} maxHeight={Math.max(height, 240)} />
        ) : (
          <Chart payload={payload} height={chartHeight(payload, height)} />
        )}
      </div>
      {payload.truncated ? <p className="mt-2 text-[12px] text-ink-3">Showing the first {rows.length.toLocaleString()} rows.</p> : null}
      {spec.insight ? (
        <p className="mt-3 flex gap-1.5 text-[13px] text-ink-2 border-t border-line pt-2.5">
          <Sparkles size={13} className="mt-1 shrink-0 text-accent" aria-hidden />
          {spec.insight}
        </p>
      ) : null}
    </section>
  );
}

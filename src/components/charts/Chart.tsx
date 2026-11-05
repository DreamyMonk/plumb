"use client";

import { useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { prepare, scatterGroups, seriesColor } from "@/lib/chart-data";
import { axisFormatter, compact, exactValue, formatTick, formatValue, humanize } from "@/lib/format";
import type { ChartPayload, Row, ValueFormat } from "@/lib/types";
import { ArrowDown, ArrowUp } from "lucide-react";

const tick = { fill: "var(--ink-3)", fontSize: 11 };
const axisLine = { stroke: "var(--line)" };
const grid = { stroke: "var(--grid)", strokeWidth: 1 };
const crosshair = { stroke: "var(--ink-3)", strokeWidth: 1 };
const barHover = { fill: "var(--surface-2)" };
const margin = { top: 8, right: 12, bottom: 0, left: 0 };

interface ReadoutEntry {
  name?: string | number;
  value?: unknown;
  color?: string;
  dataKey?: unknown;
}

interface ReadoutProps {
  active?: boolean;
  label?: unknown;
  payload?: readonly ReadoutEntry[];
  format?: ValueFormat;
  currency?: string;
  hide?: string[];
}

function Readout({ active, label, payload, format, currency, hide = [] }: ReadoutProps) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((entry) => !hide.includes(String(entry.dataKey)) && entry.value !== null && entry.value !== undefined);
  if (rows.length === 0) return null;
  return (
    <div className="rounded-lg border border-line bg-surface shadow-sm px-2.5 py-1.5 text-[12px] max-w-64">
      {label !== undefined && label !== "" ? <p className="text-ink-3 mb-0.5">{formatTick(label)}</p> : null}
      {rows.map((entry, index) => (
        <div key={index} className="flex items-center gap-2 tnum">
          <span className="w-3 h-0.5 rounded-full shrink-0" style={{ background: entry.color }} aria-hidden />
          <span className="font-semibold">{exactValue(entry.value, format, currency)}</span>
          <span className="text-ink-2 truncate">{humanize(String(entry.name))}</span>
        </div>
      ))}
    </div>
  );
}

function Legend({ items }: { items: { name: string; color: string; dashed?: boolean; wash?: boolean }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-3.5 gap-y-1 mb-2 text-[12px] text-ink-2">
      {items.map((item) => (
        <li key={item.name} className="flex items-center gap-1.5">
          {item.wash ? (
            <span className="w-3 h-2.5 rounded-sm" style={{ background: item.color, opacity: 0.2 }} aria-hidden />
          ) : item.dashed ? (
            <span className="w-3.5 border-t-2 border-dashed" style={{ borderColor: item.color }} aria-hidden />
          ) : (
            <span className="size-2 rounded-full" style={{ background: item.color }} aria-hidden />
          )}
          {humanize(item.name)}
        </li>
      ))}
    </ul>
  );
}

function Kpi({ payload }: { payload: ChartPayload }) {
  const { spec, rows } = payload;
  const row = rows[0] ?? {};
  const key = "value" in row ? "value" : (spec.y?.[0] ?? "");
  const value = row[key];
  const previous = row.previous === null || row.previous === undefined ? null : Number(row.previous);
  const delta = previous ? (Number(value) - previous) / Math.abs(previous) : null;
  return (
    <div>
      <p className="text-[28px] font-semibold tracking-tight leading-none">{formatValue(value, spec.format, spec.currency)}</p>
      {delta !== null && Number.isFinite(delta) ? (
        <p className="mt-2 flex items-center gap-1 text-[12.5px] text-ink-2">
          {delta >= 0 ? <ArrowUp size={13} aria-hidden /> : <ArrowDown size={13} aria-hidden />}
          <span className="tnum">{delta >= 0 ? "+" : ""}{(delta * 100).toFixed(1)}%</span>
          <span className="text-ink-3">vs prior period</span>
        </p>
      ) : null}
    </div>
  );
}

const RAMP = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281"];

function Heatmap({ payload }: { payload: ChartPayload }) {
  const { spec, rows } = payload;
  const [hover, setHover] = useState<string | null>(null);
  const x = spec.x ?? "";
  const yLabel = spec.series ?? "";
  const value = spec.y?.[0] ?? "";
  const columns = [...new Set(rows.map((r) => String(r[x])))];
  const lines = [...new Set(rows.map((r) => String(r[yLabel])))];
  const lookup = new Map(rows.map((r) => [`${r[yLabel]}\u0001${r[x]}`, Number(r[value])]));
  const values = [...lookup.values()].filter(Number.isFinite);
  const [min, max] = [Math.min(...values), Math.max(...values)];
  const color = (n: number) => RAMP[Math.round(((n - min) / (max - min || 1)) * (RAMP.length - 1))];
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-separate" style={{ borderSpacing: 2 }}>
          <thead>
            <tr>
              <th />
              {columns.map((c) => (
                <th key={c} className="text-[11px] font-normal text-ink-3 px-1 pb-1 whitespace-nowrap">{formatTick(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line}>
                <th className="text-[11px] font-normal text-ink-3 text-right pr-2 whitespace-nowrap">{formatTick(line)}</th>
                {columns.map((c) => {
                  const n = lookup.get(`${line}\u0001${c}`);
                  const text = n === undefined ? "No data" : exactValue(n, spec.format, spec.currency);
                  return (
                    <td
                      key={c}
                      tabIndex={0}
                      aria-label={`${line}, ${c}: ${text}`}
                      className="h-7 min-w-8 rounded-[3px]"
                      style={{ background: n === undefined ? "var(--surface-2)" : color(n) }}
                      onPointerEnter={() => setHover(`${line} · ${formatTick(c)}: ${text}`)}
                      onPointerLeave={() => setHover(null)}
                      onFocus={() => setHover(`${line} · ${formatTick(c)}: ${text}`)}
                      onBlur={() => setHover(null)}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[12px] text-ink-2 h-4 tnum">{hover ?? `${humanize(value)}: low to high, darker is higher`}</p>
    </div>
  );
}

function Forecast({ payload, height }: { payload: ChartPayload; height: number }) {
  const rows = payload.rows.map((row) => ({ ...row, band: row.lower === null || row.lower === undefined ? null : [row.lower, row.upper] }));
  return (
    <div>
      <Legend
        items={[
          { name: "Actual", color: "var(--series-1)" },
          { name: "Forecast", color: "var(--series-1)", dashed: true },
          { name: "Likely range (~80%)", color: "var(--series-1)", wash: true },
        ]}
      />
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={rows} margin={margin}>
          <CartesianGrid vertical={false} {...grid} />
          <XAxis dataKey="date" tick={tick} tickLine={false} axisLine={axisLine} tickFormatter={axisFormatter(rows, "date")} minTickGap={40} />
          <YAxis tick={tick} tickLine={false} axisLine={false} tickFormatter={(v) => compact(Number(v))} width={48} />
          <Tooltip cursor={crosshair} content={(props) => <ForecastReadout {...(props as unknown as ReadoutProps)} />} />
          <Area dataKey="band" stroke="none" fill="var(--series-1)" fillOpacity={0.14} isAnimationActive={false} connectNulls={false} activeDot={false} />
          <Line dataKey="actual" stroke="var(--series-1)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} />
          <Line dataKey="forecast" stroke="var(--series-1)" strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} connectNulls={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function ForecastReadout({ active, label, payload }: ReadoutProps) {
  if (!active || !payload?.length) return null;
  const row = (payload[0] as unknown as { payload: Row }).payload;
  const isFuture = row.actual === null || row.actual === undefined;
  return (
    <div className="rounded-lg border border-line bg-surface shadow-sm px-2.5 py-1.5 text-[12px] tnum">
      <p className="text-ink-3 mb-0.5">{formatTick(label)}</p>
      <p>
        <span className="font-semibold">{exactValue(isFuture ? row.forecast : row.actual, undefined)}</span>{" "}
        <span className="text-ink-2">{isFuture ? "forecast" : "actual"}</span>
      </p>
      {isFuture ? <p className="text-ink-2">{exactValue(row.lower, undefined)} to {exactValue(row.upper, undefined)}</p> : null}
    </div>
  );
}

function hbarAxisWidth(rows: Row[], key: string) {
  const longest = rows.reduce((max, row) => Math.max(max, String(row[key] ?? "").length), 0);
  return Math.min(150, Math.max(48, longest * 6.4 + 8));
}

export function chartHeight(payload: ChartPayload, base: number): number {
  if (payload.spec.type === "hbar") return Math.max(base, Math.min(520, prepare(payload).rows.length * 30 + 24));
  return base;
}

export function Chart({ payload, height = 260 }: { payload: ChartPayload; height?: number }) {
  const { spec } = payload;
  if (spec.type === "kpi") return <Kpi payload={payload} />;
  if (spec.type === "heatmap") return <Heatmap payload={payload} />;
  if (spec.type === "forecast") return <Forecast payload={payload} height={height} />;

  const format = spec.format;
  const currency = spec.currency;

  if (spec.type === "scatter") {
    const groups = scatterGroups(payload);
    const names = groups.map((g) => g.name);
    const yKey = spec.y?.[0] ?? "";
    return (
      <div>
        {groups.length > 1 ? <Legend items={names.map((name) => ({ name, color: seriesColor(names, name) }))} /> : null}
        <ResponsiveContainer width="100%" height={height}>
          <ScatterChart margin={{ ...margin, bottom: 14 }}>
            <CartesianGrid {...grid} />
            <XAxis type="number" dataKey={spec.x} name={spec.x} tick={tick} tickLine={false} axisLine={axisLine} tickFormatter={(v) => compact(Number(v))} domain={["auto", "auto"]} label={{ value: humanize(spec.x ?? ""), position: "insideBottom", offset: -8, fill: "var(--ink-3)", fontSize: 11 }} />
            <YAxis type="number" dataKey={yKey} name={yKey} tick={tick} tickLine={false} axisLine={false} tickFormatter={(v) => formatValue(v, format, currency)} width={52} domain={["auto", "auto"]} />
            <ZAxis range={[60, 60]} />
            <Tooltip cursor={false} content={(props) => <Readout {...(props as unknown as ReadoutProps)} label="" format={format} currency={currency} />} />
            {groups.map((group) => (
              <Scatter key={group.name} name={group.name} data={group.points} fill={seriesColor(names, group.name)} stroke="var(--surface)" strokeWidth={1.5} fillOpacity={0.85} isAnimationActive={false} />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    );
  }

  const { rows, keys, xKey } = prepare(payload);
  const legend = keys.length > 1 ? <Legend items={keys.map((key) => ({ name: key, color: seriesColor(keys, key) }))} /> : null;
  const yTicks = (value: number) => formatValue(value, format, currency);
  const readout = (props: unknown) => <Readout {...(props as ReadoutProps)} format={format} currency={currency} />;

  if (spec.type === "donut") {
    const key = keys[0];
    const names = rows.map((row) => String(row[xKey]));
    const total = rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);
    return (
      <div className="flex flex-col sm:flex-row items-center gap-4">
        <div className="w-full sm:w-1/2">
          <ResponsiveContainer width="100%" height={height}>
            <PieChart>
              <Tooltip content={(props) => readout({ ...(props as object), label: "" })} />
              <Pie data={rows} dataKey={key} nameKey={xKey} innerRadius="62%" outerRadius="88%" stroke="var(--surface)" strokeWidth={2} isAnimationActive={false}>
                {names.map((name) => (
                  <Cell key={name} fill={seriesColor(names, name)} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </div>
        <ul className="w-full sm:w-1/2 space-y-1 text-[12.5px]">
          {rows.map((row) => {
            const name = String(row[xKey]);
            const share = total ? ((Number(row[key]) || 0) / total) * 100 : 0;
            return (
              <li key={name} className="flex items-center gap-2">
                <span className="size-2 rounded-full shrink-0" style={{ background: seriesColor(names, name) }} aria-hidden />
                <span className="truncate text-ink-2">{name}</span>
                <span className="ml-auto tnum font-medium">{share.toFixed(0)}%</span>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  if (spec.type === "line" || spec.type === "area") {
    const dots = rows.length <= 12;
    if (spec.type === "area" && keys.length === 1) {
      return (
        <ResponsiveContainer width="100%" height={height}>
          <AreaChart data={rows} margin={margin}>
            <CartesianGrid vertical={false} {...grid} />
            <XAxis dataKey={xKey} tick={tick} tickLine={false} axisLine={axisLine} tickFormatter={axisFormatter(rows, xKey)} minTickGap={32} />
            <YAxis tick={tick} tickLine={false} axisLine={false} tickFormatter={yTicks} width={52} />
            <Tooltip cursor={crosshair} content={readout} />
            <Area dataKey={keys[0]} stroke="var(--series-1)" strokeWidth={2} fill="var(--series-1)" fillOpacity={0.1} isAnimationActive={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} />
          </AreaChart>
        </ResponsiveContainer>
      );
    }
    return (
      <div>
        {legend}
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={rows} margin={margin}>
            <CartesianGrid vertical={false} {...grid} />
            <XAxis dataKey={xKey} tick={tick} tickLine={false} axisLine={axisLine} tickFormatter={axisFormatter(rows, xKey)} minTickGap={32} />
            <YAxis tick={tick} tickLine={false} axisLine={false} tickFormatter={yTicks} width={52} />
            <Tooltip cursor={crosshair} content={readout} />
            {keys.map((key) => (
              <Line key={key} dataKey={key} stroke={seriesColor(keys, key)} strokeWidth={2} isAnimationActive={false} connectNulls dot={dots ? { r: 3, strokeWidth: 2, stroke: "var(--surface)", fill: seriesColor(keys, key) } : false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (spec.type === "hbar") {
    const stacked = Boolean(spec.series);
    const width = hbarAxisWidth(rows, xKey);
    const label = !stacked && keys.length === 1 && rows.length <= 16;
    return (
      <div>
        {legend}
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={rows} layout="vertical" margin={{ ...margin, right: label ? 48 : 12 }} barCategoryGap="28%">
            <CartesianGrid horizontal={false} {...grid} />
            <XAxis type="number" tick={tick} tickLine={false} axisLine={false} tickFormatter={yTicks} hide={label} />
            <YAxis type="category" dataKey={xKey} tick={tick} tickLine={false} axisLine={axisLine} width={width} tickFormatter={formatTick} interval={0} />
            <Tooltip cursor={barHover} content={readout} />
            {keys.map((key, index) => (
              <Bar key={key} dataKey={key} stackId={stacked ? "s" : undefined} fill={seriesColor(keys, key)} maxBarSize={24} radius={!stacked || index === keys.length - 1 ? [0, 4, 4, 0] : 0} stroke={stacked ? "var(--surface)" : undefined} strokeWidth={stacked ? 2 : 0} isAnimationActive={false}>
                {label ? <LabelList dataKey={key} position="right" formatter={(v: unknown) => formatValue(v, format, currency)} style={{ fill: "var(--ink-2)", fontSize: 11 }} /> : null}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  const stacked = spec.type === "stacked_bar";
  return (
    <div>
      {legend}
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={rows} margin={margin} barCategoryGap="28%" barGap={2}>
          <CartesianGrid vertical={false} {...grid} />
          <XAxis dataKey={xKey} tick={tick} tickLine={false} axisLine={axisLine} tickFormatter={axisFormatter(rows, xKey)} minTickGap={16} />
          <YAxis tick={tick} tickLine={false} axisLine={false} tickFormatter={yTicks} width={52} />
          <Tooltip cursor={barHover} content={readout} />
          {keys.map((key, index) => (
            <Bar key={key} dataKey={key} stackId={stacked ? "s" : undefined} fill={seriesColor(keys, key)} maxBarSize={24} radius={!stacked || index === keys.length - 1 ? [4, 4, 0, 0] : 0} stroke={stacked ? "var(--surface)" : undefined} strokeWidth={stacked ? 2 : 0} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

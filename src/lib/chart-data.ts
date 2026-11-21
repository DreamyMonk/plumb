import type { ChartPayload, EventMark, Row } from "./types";

export const OTHER_SERIES = "Other";
const MAX_SERIES = 8;
const MAX_SCATTER_SERIES = 3;

export interface Prepared {
  xKey: string;
  rows: Row[];
  keys: string[]; // value columns in the wide rows
}

export const seriesColor = (keys: string[], key: string) =>
  key === OTHER_SERIES ? "var(--series-other)" : `var(--series-${(keys.filter((k) => k !== OTHER_SERIES).indexOf(key) % 8) + 1})`;

/**
 * Pivots long rows to one column per series. Past the palette's eight slots, the
 * smallest series fold into "Other" rather than inventing a ninth color. Colors are
 * assigned alphabetically, so a series keeps its color when its rank changes.
 */
export function prepare(payload: ChartPayload): Prepared {
  const { spec, rows } = payload;
  const xKey = spec.x ?? "";
  const y = spec.y ?? [];
  if (!spec.series) return { xKey, rows, keys: y };

  const value = y[0];
  const totals = new Map<string, number>();
  for (const row of rows) {
    const name = String(row[spec.series] ?? "(blank)");
    totals.set(name, (totals.get(name) ?? 0) + Math.abs(Number(row[value]) || 0));
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const kept = new Set(ranked.length > MAX_SERIES ? ranked.slice(0, MAX_SERIES - 1) : ranked);

  const byX = new Map<unknown, Row>();
  for (const row of rows) {
    const x = row[xKey];
    if (!byX.has(x)) byX.set(x, { [xKey]: x });
    const wide = byX.get(x)!;
    const raw: string = String(row[spec.series] ?? "(blank)");
    const name = kept.has(raw) ? raw : OTHER_SERIES;
    wide[name] = (Number(wide[name]) || 0) + (Number(row[value]) || 0);
  }
  const keys = [...kept].sort((a, b) => a.localeCompare(b));
  if (ranked.length > kept.size) keys.push(OTHER_SERIES);
  return { xKey, rows: [...byX.values()], keys };
}

export interface ScatterGroup {
  name: string;
  points: Row[];
}

export function scatterGroups(payload: ChartPayload): ScatterGroup[] {
  const { spec, rows } = payload;
  if (!spec.series) return [{ name: spec.y?.[0] ?? "", points: rows }];
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const name = String(row[spec.series] ?? "(blank)");
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(row);
  }
  const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const kept = ranked.slice(0, MAX_SCATTER_SERIES);
  const rest = ranked.slice(MAX_SCATTER_SERIES).flatMap(([, points]) => points);
  const out = kept.map(([name, points]) => ({ name, points })).sort((a, b) => a.name.localeCompare(b.name));
  return rest.length ? [...out, { name: OTHER_SERIES, points: rest }] : out;
}

export interface PlacedEvent extends EventMark {
  n: number;
  x: unknown;
}

/** Places each event on the axis point covering its date, so monthly charts work too. */
export function placeEvents(events: EventMark[] | undefined, rows: Row[], xKey: string): PlacedEvent[] {
  if (!events?.length || rows.length === 0) return [];
  const labels = rows.map((row) => String(row[xKey]));
  const size = Math.min(labels[0].length, 10);
  const placed: PlacedEvent[] = [];
  for (const event of events) {
    const date = event.date.slice(0, size);
    let index = -1;
    for (let i = 0; i < labels.length && labels[i].slice(0, size) <= date; i++) index = i;
    if (index >= 0) placed.push({ ...event, n: placed.length + 1, x: rows[index][xKey] });
  }
  return placed;
}

import "server-only";
import { loadSeries, measureFor, requireDataset, type LoadedSeries, type SeriesRequest } from "./analytics";
import { ident, literal, safeQuery } from "./db";
import { eventsFor, toMarks } from "./events";
import { chanceOfSoFew, detectAnomalies, eventImpact, median } from "./ml/anomaly";
import { addPeriods, inferBaseGrain } from "./ml/forecast";
import { events } from "./store";
import type { ChartPayload, ColumnProfile, Dataset, EventImpact, Grain, Movement, PeriodExplanation, SegmentAnomaly, TimelineResult } from "./types";

const COMPARISON_PERIODS = 4;
const MAX_DIMENSIONS = 10;
const MAX_MOVERS = 6;
const NEARBY_DAYS = 3;

const MAX_SCAN_DIMENSIONS = 6;
const MAX_SCAN_SEGMENTS = 12;
const MIN_SEGMENT_SHARE = 0.05;
const MAX_EMPTY_SHARE = 0.005;
const MAX_SEGMENT_FINDINGS = 12;
// Many more series are checked here than overall, so the bar for a finding is higher.
const SEGMENT_THRESHOLD = 5;
// A low-volume group has quiet days by luck. A drop only counts when that few rows would
// happen by chance less than about once in 500 periods.
const MAX_CHANCE_OF_DROP = 0.002;
const VOLUME_CONTEXT_PERIODS = 28;

const DAY_MS = 86_400_000;


function categoryColumns(dataset: Dataset, limit: number, maxDistinct: number): ColumnProfile[] {
  return dataset.columns.filter((c) => (c.type === "text" || c.type === "boolean") && c.distinct >= 2 && c.distinct <= maxDistinct && c.nullPct < 0.9).slice(0, limit);
}

/**
 * Runs anomaly detection inside each sizeable segment. A closure in one region can vanish
 * in the company total, but stands out against that region's own history.
 */
async function scanSegments(request: SeriesRequest, series: LoadedSeries, overall: Set<string>): Promise<SegmentAnomaly[]> {
  const dataset = await requireDataset(request.table);
  const measure = await measureFor(request, dataset);
  if (!measure.zeroWhenEmpty) return []; // an average or ratio has no "missing rows means zero"
  const d = ident(request.dateColumn);
  const filter = request.where ? `AND (${request.where})` : "";
  const position = new Map(series.dates.map((date, i) => [date, i]));
  const total = series.values.reduce((sum, value) => sum + Math.abs(value), 0);
  const found: SegmentAnomaly[] = [];

  for (const column of categoryColumns(dataset, MAX_SCAN_DIMENSIONS, MAX_SCAN_SEGMENTS)) {
    const c = ident(column.name);
    const data = await safeQuery(
      `SELECT ${c}::VARCHAR AS segment, CAST(date_trunc('${series.grain}', ${d}) AS DATE)::VARCHAR AS period, ${measure.sql} AS value, COUNT(*) AS row_count
       FROM ${ident(request.table)} WHERE ${d} IS NOT NULL AND ${c} IS NOT NULL ${filter} GROUP BY 1, 2`,
      200_000,
    );
    const bySegment = new Map<string, { values: number[]; rows: number[] }>();
    for (const row of data.rows) {
      const index = position.get(String(row.period));
      if (index === undefined) continue;
      const name = String(row.segment);
      if (!bySegment.has(name)) bySegment.set(name, { values: new Array(series.dates.length).fill(0), rows: new Array(series.dates.length).fill(0) });
      const entry = bySegment.get(name)!;
      entry.values[index] = Number(row.value) || 0;
      entry.rows[index] = Number(row.row_count) || 0;
    }
    for (const [segment, { values, rows }] of bySegment) {
      const size = values.reduce((sum, value) => sum + Math.abs(value), 0);
      // Too small or too patchy, and an empty period is ordinary rather than news.
      if (size / (total || 1) < MIN_SEGMENT_SHARE) continue;
      if (values.filter((value) => value === 0).length / values.length > MAX_EMPTY_SHARE) continue;
      for (const anomaly of detectAnomalies(series.dates, values, series.grain, SEGMENT_THRESHOLD).anomalies) {
        if (anomaly.direction === "drop") {
          const at = position.get(anomaly.date) ?? 0;
          const nearby = rows.slice(Math.max(0, at - VOLUME_CONTEXT_PERIODS), at + VOLUME_CONTEXT_PERIODS + 1);
          if (chanceOfSoFew(rows[at], median(nearby)) > MAX_CHANCE_OF_DROP) continue;
        }
        found.push({ ...anomaly, dimension: column.name, segment });
      }
    }
  }
  // One line per date, and only for dates the overall number didn't already flag.
  const seen = new Set(overall);
  return found
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .filter((anomaly) => {
      if (seen.has(anomaly.date)) return false;
      seen.add(anomaly.date);
      return true;
    })
    .slice(0, MAX_SEGMENT_FINDINGS);
}

export async function buildTimeline(request: SeriesRequest): Promise<{ result: TimelineResult; chart: ChartPayload }> {
  const series = await loadSeries(request, inferBaseGrain);
  const { dates, values, grain, label, warnings } = series;
  const { expected, anomalies } = detectAnomalies(dates, values, grain);
  const segments = dates.length >= 14 ? await scanSegments(request, series, new Set(anomalies.map((a) => a.date))) : [];
  if (dates.length < 14) warnings.push(`Unusual ${grain}s need at least 14 ${grain}s of history; this has ${dates.length}.`);
  const flagged = new Set(anomalies.map((a) => a.date));
  const notes = dates.length ? await eventsFor(request.table, dates[0], addPeriods(dates[dates.length - 1], grain, 1)) : [];

  const rows = dates.map((date, i) => ({ date, value: values[i], expected: expected[i], unusual: flagged.has(date) ? values[i] : null }));
  const chart: ChartPayload = {
    spec: {
      type: "timeline",
      title: `${label} by ${grain}`,
      subtitle: `${anomalies.length} unusual ${grain}${anomalies.length === 1 ? "" : "s"} · ${notes.length} logged event${notes.length === 1 ? "" : "s"}`,
      x: "date",
      y: ["value"],
      timeline: request,
    },
    columns: [
      { name: "date", type: "DATE" },
      { name: "value", type: "DOUBLE" },
      { name: "expected", type: "DOUBLE" },
      { name: "unusual", type: "DOUBLE" },
    ],
    rows,
    events: toMarks(notes),
  };
  return { result: { grain, label, anomalies, segments, events: notes, warnings }, chart };
}

function floorToGrain(date: string, grain: Grain): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (grain === "week") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // weeks start Monday
  if (grain === "month") d.setUTCDate(1);
  if (grain === "quarter") d.setUTCMonth(d.getUTCMonth() - (d.getUTCMonth() % 3), 1);
  if (grain === "year") d.setUTCMonth(0, 1);
  return d.toISOString().slice(0, 10);
}

export interface ExplainRequest extends SeriesRequest {
  date: string;
}

/**
 * Finds which segments account for a period's change. Each period is compared with four
 * comparable ones (the same weekday in prior weeks for daily data), so a normally busy
 * Saturday isn't reported as a spike.
 */
export async function explainPeriod(request: ExplainRequest): Promise<PeriodExplanation> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.date)) throw new Error("Use a date like 2026-03-12.");
  const dataset = await requireDataset(request.table);
  const series = await loadSeries(request, inferBaseGrain);
  const { grain } = series;
  const period = floorToGrain(request.date, grain);
  const index = series.dates.indexOf(period);
  if (index < 0) throw new Error(`${period} is outside this data (${series.dates[0]} to ${series.dates[series.dates.length - 1]}).`);

  const step: Grain = grain === "day" ? "week" : grain;
  const known = new Map(series.dates.map((date, i) => [date, series.values[i]]));
  const comparison = Array.from({ length: COMPARISON_PERIODS }, (_, i) => addPeriods(period, step, -(i + 1))).filter((date) => known.has(date));
  const value = series.values[index];
  const baseline = comparison.length ? comparison.reduce((sum, date) => sum + known.get(date)!, 0) / comparison.length : null;
  const change = baseline === null ? null : value - baseline;

  const movers: Movement[] = [];
  if (comparison.length > 0 && change !== null) {
    const d = ident(request.dateColumn);
    const table = ident(request.table);
    const filter = request.where ? `AND (${request.where})` : "";
    const { sql: measure } = await measureFor(request, dataset);
    const periodList = [period, ...comparison].map((date) => `DATE ${literal(date)}`).join(", ");
    const dimensions = categoryColumns(dataset, MAX_DIMENSIONS, 30);
    const overall = baseline ? change / baseline : 0;

    for (const dimension of dimensions) {
      const c = ident(dimension.name);
      const data = await safeQuery(
        `SELECT ${c}::VARCHAR AS segment, CAST(date_trunc('${grain}', ${d}) AS DATE)::VARCHAR AS period, ${measure} AS value
         FROM ${table} WHERE CAST(date_trunc('${grain}', ${d}) AS DATE) IN (${periodList}) ${filter} GROUP BY 1, 2`,
      );
      const segments = new Map<string, { current: number; total: number }>();
      for (const row of data.rows) {
        const name = row.segment === null ? "(blank)" : String(row.segment);
        const entry = segments.get(name) ?? { current: 0, total: 0 };
        if (row.period === period) entry.current = Number(row.value) || 0;
        else entry.total += Number(row.value) || 0;
        segments.set(name, entry);
      }
      for (const [segment, { current, total }] of segments) {
        const segmentBaseline = total / comparison.length;
        const delta = current - segmentBaseline;
        movers.push({
          dimension: dimension.name,
          segment,
          value: current,
          baseline: segmentBaseline,
          change: delta,
          excess: delta - segmentBaseline * overall,
          share: change !== 0 ? delta / change : null,
        });
      }
    }
    // Ranked by excess. The biggest segment always shows the biggest raw change, even when
    // it only moved in line with everything else, so raw change would just rank by size.
    const direction = Math.sign(change) || 1;
    movers.sort((a, b) => b.excess * direction - a.excess * direction);
  }

  const from = new Date(Date.parse(period) - NEARBY_DAYS * DAY_MS).toISOString().slice(0, 10);
  const to = new Date(Date.parse(addPeriods(period, grain, 1)) + NEARBY_DAYS * DAY_MS).toISOString().slice(0, 10);
  return {
    date: period,
    grain,
    label: series.label,
    value,
    baseline,
    change,
    changePct: baseline ? (change ?? 0) / Math.abs(baseline) : null,
    comparedWith: comparison,
    movers: movers.slice(0, MAX_MOVERS),
    events: await eventsFor(request.table, from, to),
  };
}

export interface ImpactRequest extends SeriesRequest {
  eventId?: string | null;
  date?: string | null;
  window?: number | null;
}

export async function measureImpact(request: ImpactRequest): Promise<EventImpact & { title?: string }> {
  const event = request.eventId ? await events.get(request.eventId) : null;
  const date = event?.date ?? request.date;
  if (!date) throw new Error("Choose an event or a date.");
  const { dates, values, grain } = await loadSeries(request, inferBaseGrain);
  const impact = eventImpact({ dates, values, grain, eventDate: date, window: request.window ?? undefined });
  return { ...impact, title: event?.title };
}

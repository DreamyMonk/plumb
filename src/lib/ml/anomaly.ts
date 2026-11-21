import type { Anomaly, EventImpact, Grain, ImpactVerdict } from "../types";

// Pure statistics for "what happened when". Like forecasting, these numbers come from the
// data itself. The language model only ever reads the results.

const WINDOW: Record<Grain, number> = { day: 29, week: 13, month: 13, quarter: 9, year: 5 };
const SEASON: Record<Grain, number> = { day: 7, week: 52, month: 12, quarter: 4, year: 1 };
const DEFAULT_IMPACT_WINDOW: Record<Grain, number> = { day: 14, week: 4, month: 3, quarter: 2, year: 1 };

const THRESHOLD = 3.5;
const MIN_POINTS = 14;
const MIN_SPREAD_WINDOW = 15;
const MIN_IMPACT_WINDOW = 3;
/** Below this relative noise, small wobbles in a very smooth series would all look extreme. */
const SCALE_FLOOR = 0.02;
const MAX_ANOMALIES = 50;

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * A robust local level. Past the ends, where no centered window fits, the level continues
 * along the overall slope so a trending series isn't held flat at its edges.
 */
function rollingMedian(values: number[], window: number): number[] {
  const half = window >> 1;
  const last = values.length - 1 - half;
  if (last <= half) {
    const flat = median(values);
    return values.map(() => flat);
  }
  const level = values.map((_, i) => median(values.slice(Math.max(0, i - half), i + half + 1)));
  const slope = (level[last] - level[half]) / (last - half);
  return level.map((v, i) => (i < half ? level[half] - slope * (half - i) : i > last ? level[last] + slope * (i - last) : v));
}

/**
 * What each point "should" have been: a robust local level, adjusted for the repeating
 * cycle (weekday for daily data, month of year for monthly). The cycle is estimated, then
 * removed so the level can be measured on data with no wave left in it, then estimated
 * again from that cleaner level. Medians are used throughout, so the anomalies being
 * looked for can't drag the baseline toward themselves.
 */
export function expectedValues(values: number[], grain: Grain): number[] {
  const window = WINDOW[grain];
  let level = rollingMedian(values, window);
  const season = SEASON[grain];
  if (season <= 1 || values.length < season * 2) return level;

  const positive = values.every((v) => v >= 0) && level.every((v) => v > 0);
  const cycle = (base: number[]) => {
    const byPhase: number[][] = Array.from({ length: season }, () => []);
    values.forEach((value, i) => byPhase[i % season].push(positive ? value / base[i] : value - base[i]));
    return byPhase.map(median);
  };
  let effect = cycle(level);
  level = rollingMedian(values.map((value, i) => (positive ? value / (effect[i % season] || 1) : value - effect[i % season])), window);
  if (positive && level.some((v) => v <= 0)) return values.map(() => median(values));
  effect = cycle(level);
  return level.map((v, i) => (positive ? v * effect[i % season] : v + effect[i % season]));
}

/** Noise measured around each point, since a quiet early period is far noisier than a busy later one. */
function localSpread(residuals: number[], width: number): number[] {
  const half = width >> 1;
  const lastStart = Math.max(0, residuals.length - width);
  return residuals.map((_, i) => {
    const start = Math.min(Math.max(0, i - half), lastStart);
    const window = residuals.slice(start, start + width);
    const center = median(window);
    return 1.4826 * median(window.map((r) => Math.abs(r - center)));
  });
}

export function detectAnomalies(dates: string[], values: number[], grain: Grain, threshold = THRESHOLD): { expected: number[]; anomalies: Anomaly[] } {
  const expected = expectedValues(values, grain);
  if (values.length < MIN_POINTS) return { expected, anomalies: [] };

  // Sales-like numbers are skewed: a day can be 5x normal but can't fall below zero.
  // Log ratios treat both directions evenly, so drops are as visible as spikes.
  const positive = values.every((v) => v >= 0) && expected.every((v) => v >= 0);
  const offset = Math.max(median(values.map(Math.abs)) * 0.01, 1e-9);
  const residuals = values.map((value, i) => (positive ? Math.log((value + offset) / (expected[i] + offset)) : value - expected[i]));
  const center = median(residuals);
  const floor = positive ? SCALE_FLOOR : SCALE_FLOOR * (median(values.map(Math.abs)) || 1);
  const spread = localSpread(residuals, Math.max(MIN_SPREAD_WINDOW, WINDOW[grain] * 4));

  const anomalies: Anomaly[] = [];
  residuals.forEach((residual, i) => {
    const score = (residual - center) / Math.max(spread[i], floor);
    if (Math.abs(score) >= threshold) {
      anomalies.push({
        date: dates[i],
        value: values[i],
        expected: expected[i],
        change: values[i] - expected[i],
        changePct: expected[i] !== 0 ? (values[i] - expected[i]) / Math.abs(expected[i]) : null,
        score,
        direction: score > 0 ? "spike" : "drop",
      });
    }
  });
  anomalies.sort((x, y) => Math.abs(y.score) - Math.abs(x.score));
  return { expected, anomalies: anomalies.slice(0, MAX_ANOMALIES) };
}

/** Chance of seeing `count` or fewer rows in a period that usually has `expected`. */
export function chanceOfSoFew(count: number, expected: number): number {
  let term = Math.exp(-expected);
  let total = term;
  for (let i = 1; i <= count; i++) {
    term *= expected / i;
    total += term;
  }
  return Math.min(1, total);
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

interface ImpactInput {
  dates: string[];
  values: number[];
  grain: Grain;
  eventDate: string;
  window?: number;
}

/**
 * Compares the periods after an event with the periods before it, then asks how often an
 * ordinary date in this series shows a change that large. That placebo check is what keeps
 * seasonality or normal drift from being reported as the event's effect.
 */
export function eventImpact({ dates, values, grain, eventDate, window }: ImpactInput): EventImpact {
  const empty = (note: string): EventImpact => ({
    date: eventDate,
    grain,
    window: 0,
    before: null,
    after: null,
    change: null,
    changePct: null,
    placeboShare: null,
    verdict: "insufficient",
    note,
  });

  const start = dates.findIndex((date) => date >= eventDate.slice(0, 10));
  if (start < 0) return empty("This event is after the end of the data.");
  if (start === 0) return empty("There is no data before this event to compare with.");

  // Daily windows stay in whole weeks, so both sides hold the same mix of weekdays.
  const wanted = window ?? DEFAULT_IMPACT_WINDOW[grain];
  let width = Math.min(wanted, start, values.length - start);
  if (grain === "day" && width >= 7) width -= width % 7;
  if (width < Math.min(MIN_IMPACT_WINDOW, wanted)) {
    return empty(`Only ${Math.min(start, values.length - start)} ${grain}(s) of data on one side of this event. That is too little to compare.`);
  }

  const shiftAt = (i: number) => mean(values.slice(i, i + width)) - mean(values.slice(i - width, i));
  const before = mean(values.slice(start - width, start));
  const after = mean(values.slice(start, start + width));
  const change = after - before;

  const placebos: number[] = [];
  for (let i = width; i + width <= values.length; i++) {
    if (Math.abs(i - start) >= width) placebos.push(shiftAt(i));
  }
  if (placebos.length < 10) {
    return {
      ...empty("There isn't enough other history to tell this change apart from normal movement."),
      window: width,
      before,
      after,
      change,
      changePct: before !== 0 ? change / Math.abs(before) : null,
    };
  }
  const placeboShare = placebos.filter((shift) => Math.abs(shift) >= Math.abs(change)).length / placebos.length;
  const verdict: ImpactVerdict = placeboShare < 0.05 ? "clear" : placeboShare < 0.2 ? "weak" : "none";
  const unit = `${width} ${grain}${width === 1 ? "" : "s"}`;
  const note =
    verdict === "clear"
      ? `A change this large happens around only ${(placeboShare * 100).toFixed(0)}% of other dates, so something real shifted around this event. Timing alone doesn't prove the event caused it.`
      : verdict === "weak"
        ? `A change this large happens around ${(placeboShare * 100).toFixed(0)}% of other dates. It may be real, but it isn't clearly different from normal movement.`
        : `A change this large happens around ${(placeboShare * 100).toFixed(0)}% of other dates, so this ${unit} comparison shows no clear effect.`;
  return {
    date: eventDate,
    grain,
    window: width,
    before,
    after,
    change,
    changePct: before !== 0 ? change / Math.abs(before) : null,
    placeboShare,
    verdict,
    note,
  };
}

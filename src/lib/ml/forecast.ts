import type { ForecastPoint, ForecastResult, Grain } from "../types";

// Pure forecasting code: every accuracy number comes from a rolling backtest on the
// user's own data, never from the language model.

type Forecaster = (train: number[], horizon: number) => number[];

interface Candidate {
  model: string;
  label: string;
  fit: Forecaster;
}

export const SEASON: Record<Grain, number> = { day: 7, week: 52, month: 12, quarter: 4, year: 1 };

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

function seasonalNaive(season: number): Forecaster {
  return (train, horizon) => {
    const s = season > 1 && train.length >= season ? season : 1;
    return Array.from({ length: horizon }, (_, i) => train[train.length - s + (i % s)]);
  };
}

const linearTrend: Forecaster = (train, horizon) => {
  const n = train.length;
  const xBar = (n - 1) / 2;
  const yBar = mean(train);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - xBar) * (train[i] - yBar);
    sxx += (i - xBar) ** 2;
  }
  const slope = sxx ? sxy / sxx : 0;
  return Array.from({ length: horizon }, (_, i) => yBar + slope * (n + i - xBar));
};

function holtRun(train: number[], alpha: number, beta: number, phi: number) {
  let level = train[0];
  let trend = train.length > 1 ? train[1] - train[0] : 0;
  let sse = 0;
  for (let i = 1; i < train.length; i++) {
    const predicted = level + phi * trend;
    sse += (train[i] - predicted) ** 2;
    const nextLevel = alpha * train[i] + (1 - alpha) * predicted;
    trend = beta * (nextLevel - level) + (1 - beta) * phi * trend;
    level = nextLevel;
  }
  return { level, trend, sse };
}

const GRID = [0.1, 0.3, 0.5, 0.7, 0.9];

const dampedHolt: Forecaster = (train, horizon) => {
  let best = { sse: Infinity, level: train[train.length - 1], trend: 0 };
  for (const alpha of GRID) {
    for (const beta of [0.05, 0.2, 0.5]) {
      const run = holtRun(train, alpha, beta, 0.9);
      if (run.sse < best.sse) best = run;
    }
  }
  let damp = 0;
  return Array.from({ length: horizon }, (_, i) => {
    damp += 0.9 ** (i + 1);
    return best.level + damp * best.trend;
  });
};

function winters(train: number[], season: number, alpha: number, beta: number, gamma: number, multiplicative: boolean) {
  const first = mean(train.slice(0, season));
  const second = mean(train.slice(season, season * 2));
  let level = first;
  let trend = (second - first) / season;
  const seasonal = train.slice(0, season).map((v) => (multiplicative ? v / (first || 1) : v - first));
  let sse = 0;
  for (let i = season; i < train.length; i++) {
    const s = seasonal[i % season];
    const predicted = multiplicative ? (level + trend) * s : level + trend + s;
    sse += (train[i] - predicted) ** 2;
    const nextLevel = multiplicative
      ? alpha * (train[i] / (s || 1)) + (1 - alpha) * (level + trend)
      : alpha * (train[i] - s) + (1 - alpha) * (level + trend);
    trend = beta * (nextLevel - level) + (1 - beta) * trend;
    seasonal[i % season] = multiplicative
      ? gamma * (train[i] / (nextLevel || 1)) + (1 - gamma) * s
      : gamma * (train[i] - nextLevel) + (1 - gamma) * s;
    level = nextLevel;
  }
  return { level, trend, seasonal, sse };
}

function holtWinters(season: number, multiplicative: boolean): Forecaster {
  return (train, horizon) => {
    if (train.length < season * 2) return seasonalNaive(season)(train, horizon);
    let best: ReturnType<typeof winters> | null = null;
    for (const alpha of GRID) {
      for (const beta of [0.02, 0.1, 0.3]) {
        for (const gamma of [0.1, 0.3, 0.5]) {
          const run = winters(train, season, alpha, beta, gamma, multiplicative);
          if (Number.isFinite(run.sse) && (!best || run.sse < best.sse)) best = run;
        }
      }
    }
    if (!best) return seasonalNaive(season)(train, horizon);
    const { level, trend, seasonal } = best;
    return Array.from({ length: horizon }, (_, i) => {
      const s = seasonal[(train.length + i) % season];
      return multiplicative ? (level + trend * (i + 1)) * s : level + trend * (i + 1) + s;
    });
  };
}

export function addPeriods(date: string, grain: Grain, count: number): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (grain === "day") d.setUTCDate(d.getUTCDate() + count);
  if (grain === "week") d.setUTCDate(d.getUTCDate() + 7 * count);
  if (grain === "month") d.setUTCMonth(d.getUTCMonth() + count);
  if (grain === "quarter") d.setUTCMonth(d.getUTCMonth() + 3 * count);
  if (grain === "year") d.setUTCFullYear(d.getUTCFullYear() + count);
  return d.toISOString().slice(0, 10);
}

interface Backtest {
  mae: number;
  rmse: number;
  mape: number | null;
  points: number;
}

function backtest(values: number[], fit: Forecaster, testSize: number, folds: number): Backtest {
  let absolute = 0;
  let squared = 0;
  let pct = 0;
  let pctCount = 0;
  let points = 0;
  for (let fold = 0; fold < folds; fold++) {
    const end = values.length - fold * testSize;
    const train = values.slice(0, end - testSize);
    const test = values.slice(end - testSize, end);
    const predicted = fit(train, test.length);
    for (let i = 0; i < test.length; i++) {
      const error = test[i] - predicted[i];
      absolute += Math.abs(error);
      squared += error * error;
      if (test[i] !== 0) {
        pct += Math.abs(error / test[i]);
        pctCount++;
      }
      points++;
    }
  }
  return { mae: absolute / points, rmse: Math.sqrt(squared / points), mape: pctCount ? pct / pctCount : null, points };
}

export interface SeriesInput {
  dates: string[];
  values: number[];
  grain: Grain;
  horizon: number;
  warnings?: string[];
}

export function runForecast({ dates, values, grain, horizon, warnings = [] }: SeriesInput): ForecastResult {
  const n = values.length;
  if (n < 6) throw new Error(`Forecasting needs at least 6 ${grain}s of history; this series has ${n}.`);
  const notes = [...warnings];
  const fullSeason = SEASON[grain];
  const canSeason = fullSeason > 1 && n >= fullSeason * 2 + 1;
  if (fullSeason > 1 && !canSeason) {
    notes.push(`Only ${n} ${grain}s of history, so yearly or weekly seasonality can't be learned. Two full cycles (${fullSeason * 2}) are needed.`);
  }
  const season = canSeason ? fullSeason : 1;

  const baselineLabel = season > 1 ? "Seasonal naive (repeat last cycle)" : "Naive (repeat last value)";
  const baseline: Candidate = { model: "naive", label: baselineLabel, fit: seasonalNaive(season) };
  const candidates: Candidate[] = [
    baseline,
    { model: "linear", label: "Linear trend", fit: linearTrend },
    { model: "holt", label: "Damped trend (Holt)", fit: dampedHolt },
  ];
  if (season > 1) {
    candidates.push({ model: "hw_add", label: "Holt-Winters additive", fit: holtWinters(season, false) });
    if (values.every((v) => v > 0)) {
      candidates.push({ model: "hw_mul", label: "Holt-Winters multiplicative", fit: holtWinters(season, true) });
    }
  }

  const minTrain = Math.max(4, season > 1 ? season * 2 : 4);
  const testSize = Math.max(1, Math.min(horizon, Math.floor(n * 0.2), season > 1 ? season : horizon));
  let folds = 3;
  while (folds > 1 && n - folds * testSize < minTrain) folds--;
  if (n - testSize < minTrain) {
    notes.push("Very little history: the accuracy score comes from a small test window, so treat it as rough.");
  }

  const scored = candidates.map((c) => ({ ...c, result: backtest(values, c.fit, testSize, folds) }));
  const base = scored[0];
  const best = scored.reduce((a, b) => (b.result.mae < a.result.mae ? b : a));
  const predictions = best.fit(values, horizon);

  const nonNegative = values.every((v) => v >= 0);
  const points: ForecastPoint[] = dates.map((date, i) => ({
    date,
    actual: values[i],
    forecast: i === n - 1 ? values[i] : null, // joins the two lines on the chart
    lower: i === n - 1 ? values[i] : null,
    upper: i === n - 1 ? values[i] : null,
  }));
  for (let i = 0; i < horizon; i++) {
    // ~80% band, widened with distance from the data. An approximation from backtest error.
    const spread = 1.28 * best.result.rmse * Math.sqrt(1 + i / testSize);
    const center = predictions[i];
    const clamp = (v: number) => (nonNegative ? Math.max(0, v) : v);
    points.push({
      date: addPeriods(dates[n - 1], grain, i + 1),
      actual: null,
      forecast: clamp(center),
      lower: clamp(center - spread),
      upper: clamp(center + spread),
    });
  }

  const skill = base.result.mae > 0 ? 1 - best.result.mae / base.result.mae : 0;
  if (best.model === "naive") {
    notes.push("No model beat simply repeating the recent past, so that is what this forecast does. The series may have little predictable structure.");
  }
  if (horizon > testSize * 3) {
    notes.push(`Accuracy was tested ${testSize} ${grain}${testSize === 1 ? "" : "s"} ahead; predictions past that point are less certain.`);
  }

  return {
    points,
    grain,
    horizon,
    model: best.model,
    modelLabel: best.label,
    seasonLength: season,
    mae: best.result.mae,
    mape: best.result.mape,
    baselineMae: base.result.mae,
    skill,
    testPoints: best.result.points,
    warnings: notes,
    candidates: scored.map((c) => ({ model: c.model, label: c.label, mae: c.result.mae })).sort((a, b) => a.mae - b.mae),
  };
}

export function inferGrain(sortedDates: string[]): Grain {
  if (sortedDates.length < 2) return "day";
  const gaps: number[] = [];
  for (let i = 1; i < sortedDates.length; i++) {
    gaps.push((Date.parse(sortedDates[i]) - Date.parse(sortedDates[i - 1])) / 86_400_000);
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  const spanDays = (Date.parse(sortedDates[sortedDates.length - 1]) - Date.parse(sortedDates[0])) / 86_400_000;
  if (median <= 1.5) return spanDays > 365 * 2 ? "month" : spanDays > 180 ? "week" : "day";
  if (median <= 8) return "week";
  if (median <= 35) return "month";
  if (median <= 100) return "quarter";
  return "year";
}

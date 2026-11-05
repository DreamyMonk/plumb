import "server-only";
import { ident, query, safeQuery } from "./db";
import { addPeriods, inferGrain, runForecast } from "./ml/forecast";
import { predictRow, trainForest, type FeatureSpec, type ForestArtifact } from "./ml/forest";
import { datasets, models, newId } from "./store";
import type { ChartPayload, ColumnProfile, Dataset, ForecastResult, Grain, ModelSummary, PredictionResult } from "./types";

const TRAIN_ROWS = 20_000;
const MAX_FEATURES = 40;

async function requireDataset(table: string): Promise<Dataset> {
  const dataset = await datasets.get(table).catch(() => null);
  if (!dataset) throw new Error(`There is no table named "${table}".`);
  return dataset;
}

function requireColumn(dataset: Dataset, name: string): ColumnProfile {
  const column = dataset.columns.find((c) => c.name === name);
  if (!column) throw new Error(`${dataset.id} has no column "${name}". Columns: ${dataset.columns.map((c) => c.name).join(", ")}`);
  return column;
}

export interface ForecastRequest {
  table: string;
  dateColumn: string;
  valueColumn?: string | null;
  agg: "sum" | "avg" | "count";
  grain?: Grain | null;
  horizon?: number | null;
  where?: string | null;
}

export async function forecastTable(request: ForecastRequest): Promise<{ result: ForecastResult; chart: ChartPayload }> {
  const dataset = await requireDataset(request.table);
  const dateColumn = requireColumn(dataset, request.dateColumn);
  if (dateColumn.type !== "date" && dateColumn.type !== "datetime") {
    throw new Error(`${request.dateColumn} is ${dateColumn.type}, not a date.`);
  }
  const d = ident(request.dateColumn);
  const table = ident(request.table);
  let measure = "COUNT(*)";
  if (request.agg !== "count") {
    if (!request.valueColumn) throw new Error("Pick a value column, or use count.");
    const value = requireColumn(dataset, request.valueColumn);
    if (value.type !== "integer" && value.type !== "number") throw new Error(`${request.valueColumn} is not numeric.`);
    measure = `${request.agg.toUpperCase()}(${ident(request.valueColumn)})`;
  }
  const filter = request.where ? `AND (${request.where})` : "";

  let grain = request.grain ?? null;
  if (!grain) {
    const distinct = await safeQuery(
      `SELECT DISTINCT CAST(${d} AS DATE)::VARCHAR AS day FROM ${table} WHERE ${d} IS NOT NULL ${filter} ORDER BY 1`,
      100_000,
    );
    grain = inferGrain(distinct.rows.map((r) => String(r.day)));
  }

  const data = await safeQuery(
    `SELECT CAST(date_trunc('${grain}', ${d}) AS DATE)::VARCHAR AS period, ${measure} AS value, COUNT(DISTINCT CAST(${d} AS DATE)) AS days
     FROM ${table} WHERE ${d} IS NOT NULL ${filter} GROUP BY 1 ORDER BY 1`,
    100_000,
  );
  if (data.rows.length === 0) throw new Error("No rows matched.");
  const warnings: string[] = [];

  // A half-finished last period looks like a collapse and would drag the forecast down.
  let rows = data.rows;
  if (rows.length > 3) {
    const typical = [...rows.slice(0, -1).map((r) => Number(r.days))].sort((a, b) => a - b)[Math.floor((rows.length - 1) / 2)];
    if (typical >= 2 && Number(rows[rows.length - 1].days) < typical * 0.7) {
      warnings.push(`Left out ${String(rows[rows.length - 1].period)}: that ${grain} looks incomplete.`);
      rows = rows.slice(0, -1);
    }
  }

  const byPeriod = new Map(rows.map((r) => [String(r.period), r.value === null ? null : Number(r.value)]));
  const dates: string[] = [];
  const values: (number | null)[] = [];
  const last = String(rows[rows.length - 1].period);
  for (let cursor = String(rows[0].period); cursor <= last; cursor = addPeriods(cursor, grain, 1)) {
    dates.push(cursor);
    values.push(byPeriod.get(cursor) ?? null);
  }
  const gaps = values.filter((v) => v === null).length;
  let filled: number[];
  if (request.agg === "avg") {
    let previous = values.find((v) => v !== null) ?? 0;
    filled = values.map((v) => (previous = v ?? previous));
  } else {
    filled = values.map((v) => v ?? 0); // no rows in a period means a real zero for sums and counts
  }
  if (gaps > 0) {
    warnings.push(`${gaps} ${grain}${gaps === 1 ? " had" : "s had"} no rows and ${request.agg === "avg" ? "carried the previous value" : "counted as zero"}.`);
  }

  const horizon = Math.max(1, Math.min(request.horizon ?? defaultHorizon(grain), 365));
  const result = runForecast({ dates, values: filled, grain, horizon, warnings });
  const label = request.agg === "count" ? "Rows" : `${request.agg === "avg" ? "Average" : "Total"} ${request.valueColumn}`;
  const accuracy = result.mape !== null ? `typically off by about ${(result.mape * 100).toFixed(1)}%` : `average error ${result.mae.toFixed(2)}`;
  const chart: ChartPayload = {
    spec: {
      type: "forecast",
      title: `${label} forecast`,
      subtitle: `Next ${horizon} ${grain}s · ${result.modelLabel}; ${accuracy} in backtests`,
      x: "date",
      y: ["actual", "forecast"],
    },
    columns: [
      { name: "date", type: "DATE" },
      { name: "actual", type: "DOUBLE" },
      { name: "forecast", type: "DOUBLE" },
      { name: "lower", type: "DOUBLE" },
      { name: "upper", type: "DOUBLE" },
    ],
    rows: result.points.map((point) => ({ ...point })),
  };
  return { result, chart };
}

function defaultHorizon(grain: Grain): number {
  return { day: 30, week: 12, month: 6, quarter: 4, year: 3 }[grain];
}

function isIdentifierLike(column: ColumnProfile, rowCount: number): boolean {
  if (/(^|_)(id|uuid|guid|key|email|phone|name|url)$/.test(column.name) && column.distinct > rowCount * 0.5) return true;
  return column.type === "text" && column.distinct > Math.min(200, rowCount * 0.5);
}

export interface TrainRequest {
  table: string;
  target: string;
  features?: string[] | null;
}

export async function trainTable(request: TrainRequest): Promise<ModelSummary> {
  const dataset = await requireDataset(request.table);
  const target = requireColumn(dataset, request.target);
  const skipped: string[] = [];

  const chosen = request.features?.length
    ? request.features.map((name) => requireColumn(dataset, name))
    : dataset.columns.filter((column) => {
        if (column.name === request.target || column.distinct <= 1 || column.nullPct > 0.8) return false;
        if (column.type === "date" || column.type === "datetime") {
          skipped.push(column.name);
          return false;
        }
        if (isIdentifierLike(column, dataset.rowCount)) {
          skipped.push(column.name);
          return false;
        }
        return true;
      });
  const usable = chosen.filter((c) => c.name !== request.target && c.type !== "date" && c.type !== "datetime").slice(0, MAX_FEATURES);
  const specs: FeatureSpec[] = usable.map((column) => ({
    name: column.name,
    kind: column.type === "integer" || column.type === "number" ? "numeric" : "categorical",
  }));

  const numeric = target.type === "integer" || target.type === "number";
  const task = !numeric || (target.type === "integer" && target.distinct <= 10) ? "classification" : "regression";

  const select = [request.target, ...specs.map((s) => s.name)].map(ident).join(", ");
  const sample = dataset.rowCount > TRAIN_ROWS ? `USING SAMPLE reservoir(${TRAIN_ROWS} ROWS) REPEATABLE (42)` : "";
  const rows = await query(`SELECT ${select} FROM ${ident(request.table)} WHERE ${ident(request.target)} IS NOT NULL ${sample}`);

  const { artifact, summary } = trainForest(rows, request.target, specs, task);
  if (skipped.length > 0) {
    summary.warnings.push(`Not used as inputs: ${skipped.join(", ")} (dates and identifier-like columns). Use a forecast for trends over time.`);
  }
  if (dataset.rowCount > TRAIN_ROWS) summary.warnings.push(`Trained on a random sample of ${TRAIN_ROWS.toLocaleString()} rows.`);

  const id = newId();
  const model: ModelSummary = { ...summary, id, table: request.table, createdAt: new Date().toISOString() };
  await models.save({ id, summary: model, artifact });
  return model;
}

export async function scoreModel(id: string, inputs: Record<string, unknown>[]): Promise<{ summary: ModelSummary; results: PredictionResult[] }> {
  const model = await models.get(id);
  if (!model) throw new Error(`There is no saved model "${id}".`);
  const artifact = model.artifact as ForestArtifact;
  return { summary: model.summary, results: inputs.map((input) => predictRow(artifact, input)) };
}

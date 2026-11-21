import "server-only";
import type { BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { forecastTable, scoreModel, trainTable } from "../analytics";
import { buildChart } from "../charts";
import { ident, safeQuery } from "../db";
import { datasets } from "../store";
import { buildTimeline, explainPeriod, measureImpact } from "../timeline";
import type { ChartSpec, QueryData, ToolArtifact } from "../types";
import { maskData } from "../privacy/policy";
import { toJsonSchema } from "./client";
import { describeTable, type Privacy } from "./context";

export interface ToolOutcome {
  /** What Claude reads. */
  content: string;
  /** What the user sees. */
  artifact?: ToolArtifact;
  detail?: string;
  sql?: string;
}

interface ToolDef<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  label: (input: z.infer<S>) => string;
  /** `privacy` masks anything personal in what Claude reads. The artifact keeps real values. */
  run: (input: z.infer<S>, privacy: Privacy) => Promise<ToolOutcome>;
}

const define = <S extends z.ZodType>(tool: ToolDef<S>) => tool;

const MODEL_ROW_LIMIT = 60;
const MAX_CELL = 200;

/**
 * A compact, bounded CSV view of a result, so one query can't flood the conversation.
 * Only the rows Claude will read are masked; the rest never leave the machine.
 */
async function resultForModel(data: QueryData, privacy: Privacy): Promise<string> {
  const names = data.columns.map((c) => c.name);
  const shown = (await maskData(privacy.masker, privacy.policy, data, MODEL_ROW_LIMIT)).rows;
  const cell = (value: unknown) => {
    if (value === null || value === undefined) return "";
    const text = typeof value === "number" ? String(Number(value.toPrecision(10))) : String(value);
    const clipped = text.length > MAX_CELL ? `${text.slice(0, MAX_CELL)}…` : text;
    return /[",\n]/.test(clipped) ? `"${clipped.replace(/"/g, '""')}"` : clipped;
  };
  const lines = [names.join(","), ...shown.map((row) => names.map((n) => cell(row[n])).join(","))];
  const total = data.truncated ? `more than ${data.rows.length}` : String(data.rows.length);
  const note = data.rows.length > shown.length || data.truncated ? `\n(showing ${shown.length} of ${total} rows; aggregate to see the rest)` : "";
  return `${data.rows.length} row${data.rows.length === 1 ? "" : "s"}${data.truncated ? "+" : ""}\n${lines.join("\n")}${note}`;
}

const nullable = <T extends z.ZodType>(schema: T) => schema.nullable();

const describeTableTool = define({
  name: "describe_table",
  description: "Get a table's columns with statistics plus 8 sample rows. Use it when the workspace summary isn't enough, for example to see real value formats before filtering.",
  schema: z.object({ table: z.string() }),
  label: (input) => `Inspecting ${input.table}`,
  run: async ({ table }, privacy) => {
    const dataset = await datasets.get(table).catch(() => null);
    if (!dataset) throw new Error(`There is no table named "${table}".`);
    const sample = await safeQuery(`SELECT * FROM ${ident(table)} USING SAMPLE 8 ROWS`, 8);
    return { content: `${await describeTable(dataset, privacy)}\n\nSample rows:\n${await resultForModel(sample, privacy)}` };
  },
});

const runSql = define({
  name: "run_sql",
  description:
    "Run one read-only DuckDB SELECT and get the rows back. Use it for every figure you report. Results over 60 rows are cut off for you, so aggregate. Set show_user to true only when the user would want to see the table itself.",
  schema: z.object({
    sql: z.string().describe("One DuckDB SELECT statement. Quote identifiers with double quotes."),
    show_user: z.boolean(),
  }),
  label: () => "Querying the data",
  run: async ({ sql, show_user }, privacy) => {
    const data = await safeQuery(sql);
    return {
      content: await resultForModel(data, privacy),
      sql,
      detail: `${data.rows.length.toLocaleString()}${data.truncated ? "+" : ""} rows in ${data.ms} ms`,
      artifact: show_user ? { kind: "table", sql, data: { ...data, rows: data.rows.slice(0, 500) } } : undefined,
    };
  },
});

const chartTypes = ["line", "area", "bar", "hbar", "stacked_bar", "scatter", "donut", "heatmap", "table", "kpi"] as const;

export const chartSchema = z.object({
  type: z.enum(chartTypes),
  title: z.string().describe("States the finding, e.g. 'West drives 60% of revenue'"),
  subtitle: nullable(z.string()).describe("What is plotted, with units and period"),
  sql: z.string().describe("One DuckDB SELECT producing exactly the rows to plot, already ordered."),
  currency: nullable(z.string()).describe("Currency symbol for format currency, from the column unit, e.g. $ or €"),
  x: nullable(z.string()).describe("Result column for the x axis (or the row label on hbar, donut). Null for kpi."),
  y: nullable(z.array(z.string())).describe("Numeric result columns. They share one axis, so they must share a unit. For heatmap: the one value column."),
  series: nullable(z.string()).describe("Result column that splits long-format rows into series. For heatmap: the row-label column."),
  format: nullable(z.enum(["number", "currency", "percent"])).describe("For percent, values are already on a 0-100 scale: 12.5 means 12.5%."),
  insight: nullable(z.string()).describe("One sentence on what this shows, using numbers you have seen."),
});

export function toSpec(input: z.infer<typeof chartSchema>): ChartSpec {
  return {
    type: input.type,
    title: input.title,
    subtitle: input.subtitle ?? undefined,
    sql: input.sql,
    x: input.x ?? undefined,
    y: input.y ?? undefined,
    series: input.series ?? undefined,
    format: input.format ?? undefined,
    currency: input.currency ?? undefined,
    insight: input.insight ?? undefined,
  };
}

const createChart = define({
  name: "create_chart",
  description: `Run a query and show the user a chart they can pin to a dashboard. Choose the form from the job:
- change over time: line (or area for one total); bar for few periods
- comparing categories: hbar sorted descending, up to 30 rows; bar for short labels
- part of a whole: stacked_bar; donut only for 2-5 slices
- relationship between two measures: scatter (sample to 1000 rows or fewer, up to 3 series)
- two categories crossed with a measure: heatmap
- one headline number: kpi, a single row with a "value" column and optionally "previous"
- exact values matter: table
A chart has one y axis. Measures with different units go in separate charts. For more than 8 series, keep the top ones in SQL.`,
  schema: chartSchema,
  label: (input) => `Charting: ${input.title}`,
  run: async (input, privacy) => {
    const payload = await buildChart(toSpec(input));
    const preview = await resultForModel({ columns: payload.columns, rows: payload.rows, truncated: Boolean(payload.truncated), ms: 0 }, privacy);
    return {
      content: `The chart is on screen.\n${preview}`,
      sql: input.sql,
      detail: `${payload.rows.length.toLocaleString()} rows`,
      artifact: { kind: "chart", payload },
    };
  },
});

const forecast = define({
  name: "forecast",
  description:
    "Forecast a time series from a table. Compares trend and seasonal models by rolling backtest on the user's data, shows a chart with an ~80% band, and returns accuracy against a naive baseline. Report that accuracy and every warning to the user.",
  schema: z.object({
    table: z.string(),
    date_column: z.string(),
    value_column: nullable(z.string()).describe("Numeric column. Null when agg is count."),
    agg: z.enum(["sum", "avg", "count"]),
    grain: nullable(z.enum(["day", "week", "month", "quarter", "year"])).describe("Null to detect it from the data."),
    horizon: nullable(z.number().int()).describe("Periods ahead. Null for a sensible default."),
    where: nullable(z.string()).describe("Optional SQL filter, e.g. region = 'West'"),
  }),
  label: (input) => `Forecasting ${input.value_column ?? "rows"} in ${input.table}`,
  run: async (input) => {
    const { result, chart } = await forecastTable({
      table: input.table,
      dateColumn: input.date_column,
      valueColumn: input.value_column,
      agg: input.agg,
      grain: input.grain,
      horizon: input.horizon,
      where: input.where,
    });
    const future = result.points.filter((p) => p.actual === null);
    const lines = future.slice(0, 24).map((p) => `${p.date}: ${p.forecast?.toFixed(2)} (${p.lower?.toFixed(2)} to ${p.upper?.toFixed(2)})`);
    return {
      content: [
        "The forecast chart is on screen.",
        `Model: ${result.modelLabel}. Backtest over ${result.testPoints} points: MAE ${result.mae.toFixed(2)}${result.mape !== null ? `, MAPE ${(result.mape * 100).toFixed(1)}%` : ""}; naive baseline MAE ${result.baselineMae.toFixed(2)}; skill ${(result.skill * 100).toFixed(0)}% better than baseline.`,
        `Forecast (with ~80% band):\n${lines.join("\n")}`,
        result.warnings.length ? `Warnings:\n- ${result.warnings.join("\n- ")}` : "",
      ].filter(Boolean).join("\n"),
      detail: result.modelLabel,
      artifact: { kind: "chart", payload: chart },
    };
  },
});

const trainModel = define({
  name: "train_model",
  description:
    "Train a random forest to predict a column, with a held-out test set and permutation importance. Use for 'what drives X' or 'predict X'. Returns a model_id for predict. Report the test metrics, the baseline and every warning. Importance shows what helps prediction, not what causes the outcome.",
  schema: z.object({
    table: z.string(),
    target: z.string(),
    features: nullable(z.array(z.string())).describe("Null to pick usable columns automatically."),
  }),
  label: (input) => `Training a model for ${input.target}`,
  run: async (input, { masker, policy }) => {
    const model = await trainTable(input);
    const importance = model.features.slice(0, 12).map((f) => `${f.name}: ${(f.importance * 100).toFixed(1)}%`).join(", ");
    const level = (feature: string, value: string) => {
      const kind = policy.kindOf(model.table, feature);
      return kind ? masker.token(kind, value) : masker.remask(value);
    };
    const inputs = model.features.map((f) => `${f.name} (${f.type}${f.levels ? `: ${f.levels.slice(0, 8).map((l) => level(f.name, l)).join(", ")}` : ""})`).join("; ");
    return {
      content: [
        `model_id: ${model.id}. ${model.task} on ${model.rowsTrained} rows, tested on ${model.rowsTested} held-out rows.`,
        `Test metrics: ${JSON.stringify(model.metrics)}. Baseline: ${JSON.stringify(model.baseline)}.`,
        `Importance: ${importance}.`,
        `Inputs: ${inputs}.`,
        model.warnings.length ? `Warnings:\n- ${model.warnings.join("\n- ")}` : "",
      ].filter(Boolean).join("\n"),
      detail: `${model.task}, ${model.rowsTrained.toLocaleString()} rows`,
      artifact: { kind: "model", model },
    };
  },
});

const predict = define({
  name: "predict",
  description: "Score new cases with a model from train_model. Inputs not supplied use the training median or the most typical value.",
  schema: z.object({
    model_id: z.string(),
    inputs: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  }),
  label: () => "Scoring new cases",
  run: async ({ model_id, inputs }, { masker, policy }) => {
    const { summary, results } = await scoreModel(model_id, inputs);
    const kind = policy.kindOf(summary.table, summary.target);
    const label = (value: string | number) => (kind && typeof value === "string" ? masker.token(kind, value) : value);
    const forModel = results.map((r, i) => ({
      input: inputs[i],
      ...r,
      prediction: label(r.prediction),
      probabilities: r.probabilities?.map((p) => ({ ...p, label: label(p.label) })),
    }));
    return {
      content: JSON.stringify(forModel),
      artifact: { kind: "prediction", model: model_id, target: summary.target, results },
    };
  },
});

const seriesFields = {
  table: z.string(),
  date_column: z.string(),
  value_column: nullable(z.string()).describe("Numeric column. Null when agg is count."),
  agg: z.enum(["sum", "avg", "count"]),
  grain: nullable(z.enum(["day", "week", "month", "quarter", "year"])).describe("Null to use the data's own spacing."),
  where: nullable(z.string()).describe("Optional SQL filter, e.g. region = 'West'"),
};

type SeriesInput = { table: string; date_column: string; value_column: string | null; agg: "sum" | "avg" | "count"; grain: "day" | "week" | "month" | "quarter" | "year" | null; where: string | null };

const seriesRequest = (input: SeriesInput) => ({
  table: input.table,
  dateColumn: input.date_column,
  valueColumn: input.value_column,
  agg: input.agg,
  grain: input.grain,
  where: input.where,
});

const findAnomalies = define({
  name: "find_anomalies",
  description:
    "Find unusual days or periods in a time series, allowing for trend and weekday or seasonal patterns, and show a chart with logged events marked on it. Use for 'anything unusual', 'what stands out', 'when did things go wrong'. Report the warnings it returns.",
  schema: z.object(seriesFields),
  label: (input) => `Looking for unusual periods in ${input.table}`,
  run: async (input, { masker, policy }) => {
    const { result, chart } = await buildTimeline(seriesRequest(input));
    const segment = (dimension: string, value: string) => {
      const kind = policy.kindOf(input.table, dimension);
      return kind ? masker.token(kind, value) : masker.remask(value);
    };
    const lines = result.anomalies.slice(0, 20).map((a) => `${a.date}: ${a.value.toFixed(2)} vs ${a.expected.toFixed(2)} expected (${a.direction}, score ${a.score.toFixed(1)})`);
    const hidden = result.segments.map((a) => `${a.date}: ${a.dimension}=${segment(a.dimension, a.segment)} ${a.value.toFixed(2)} vs ${a.expected.toFixed(2)} expected (${a.direction})`);
    const notes = result.events.slice(0, 20).map((e) => `${e.date} [${e.category}] ${e.title}`);
    return {
      content: [
        `The timeline chart is on screen. ${result.label} by ${result.grain}. ${result.anomalies.length} unusual ${result.grain}s, strongest first.`,
        lines.join("\n") || "None found.",
        hidden.length ? `Unusual inside one segment, which the total may hide:\n${hidden.join("\n")}` : "",
        notes.length ? `Logged events in this range:\n${notes.join("\n")}` : "No logged events in this range.",
        result.warnings.length ? `Warnings:\n- ${result.warnings.join("\n- ")}` : "",
      ].filter(Boolean).join("\n"),
      detail: `${result.anomalies.length} unusual`,
      artifact: { kind: "chart", payload: chart },
    };
  },
});

const explainDate = define({
  name: "explain_date",
  description:
    "Explain one day or period: how it compares with four comparable periods, which segments account for the change across the table's category columns, and which logged events fall nearby. Use for 'what happened on this date' or 'why did this move'. The segments show where the change sits, not why it happened.",
  schema: z.object({ ...seriesFields, date: z.string().describe("YYYY-MM-DD") }),
  label: (input) => `Breaking down ${input.date}`,
  run: async (input, { masker, policy }) => {
    const result = await explainPeriod({ ...seriesRequest(input), date: input.date });
    const rows = result.movers.map((m) => ({ column: m.dimension, segment: m.segment, value: m.value, usual: Math.round(m.baseline * 100) / 100, change: Math.round(m.change * 100) / 100 }));
    const segment = (dimension: string, value: string) => {
      const kind = policy.kindOf(input.table, dimension);
      return kind ? masker.token(kind, value) : value;
    };
    return {
      content: JSON.stringify({
        ...result,
        movers: result.movers.map((m) => ({ ...m, segment: segment(m.dimension, m.segment) })),
        events: result.events.map((e) => ({ date: e.date, category: e.category, title: e.title, detail: e.detail })),
      }),
      detail: result.changePct === null ? undefined : `${result.changePct >= 0 ? "+" : ""}${(result.changePct * 100).toFixed(0)}% vs usual`,
      artifact: rows.length
        ? {
            kind: "table",
            sql: "",
            data: {
              columns: [
                { name: "column", type: "VARCHAR" },
                { name: "segment", type: "VARCHAR" },
                { name: "value", type: "DOUBLE" },
                { name: "usual", type: "DOUBLE" },
                { name: "change", type: "DOUBLE" },
              ],
              rows,
              truncated: false,
              ms: 0,
            },
          }
        : undefined,
    };
  },
});

const measureEvent = define({
  name: "event_impact",
  description:
    "Measure whether a measure changed around a date, comparing periods before and after it, then testing how often ordinary dates show a change that large. Use for 'did the campaign work' or 'did the release change anything'. Report the verdict as given. This shows timing, not proof of cause.",
  schema: z.object({ ...seriesFields, date: z.string().describe("The event date, YYYY-MM-DD"), window: nullable(z.number().int()).describe("Periods on each side. Null for a sensible default.") }),
  label: (input) => `Measuring the change around ${input.date}`,
  run: async (input) => {
    const result = await measureImpact({ ...seriesRequest(input), date: input.date, window: input.window });
    return { content: JSON.stringify(result), detail: result.verdict };
  },
});

const tools = [describeTableTool, runSql, createChart, forecast, trainModel, predict, findAnomalies, explainDate, measureEvent];

/** Fixed and in a fixed order: the request's tool list must never vary inside a conversation. */
export const toolDefinitions = tools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: toJsonSchema(tool.schema),
  eager_input_streaming: true,
})) as BetaToolUnion[];

/** Labels are shown to the user, so they're built from the unmasked input. */
export function toolLabel(name: string, input: unknown): string {
  const tool = tools.find((t) => t.name === name) as ToolDef<z.ZodType> | undefined;
  const parsed = tool?.schema.safeParse(input);
  return parsed?.success ? tool!.label(parsed.data) : name;
}

/**
 * Runs a tool for Claude. Tokens in the input (for example inside SQL) become real values
 * before anything runs, and the text that goes back is checked one last time for personal
 * values, which catches a database error that quotes one.
 */
export async function runTool(name: string, input: unknown, privacy: Privacy): Promise<ToolOutcome> {
  const tool = tools.find((t) => t.name === name) as ToolDef<z.ZodType> | undefined;
  if (!tool) throw new Error(`Unknown tool ${name}`);
  // Eager streaming skips server-side validation, so a truncated input is caught here.
  const parsed = tool.schema.safeParse(privacy.masker.unmaskInput(input));
  if (!parsed.success) {
    throw new Error(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  const outcome = await tool.run(parsed.data, privacy);
  return { ...outcome, content: privacy.masker.remask(outcome.content) };
}

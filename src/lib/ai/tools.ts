import "server-only";
import type { BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { forecastTable, scoreModel, trainTable } from "../analytics";
import { buildChart } from "../charts";
import { ident, safeQuery } from "../db";
import { datasets } from "../store";
import type { ChartSpec, QueryData, ToolArtifact } from "../types";
import { toJsonSchema } from "./client";
import { describeTable } from "./context";

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
  run: (input: z.infer<S>) => Promise<ToolOutcome>;
}

const define = <S extends z.ZodType>(tool: ToolDef<S>) => tool;

const MODEL_ROW_LIMIT = 60;
const MAX_CELL = 200;

/** A compact, bounded CSV view of a result, so one query can't flood the conversation. */
function resultForModel(data: QueryData): string {
  const names = data.columns.map((c) => c.name);
  const shown = data.rows.slice(0, MODEL_ROW_LIMIT);
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
  run: async ({ table }) => {
    const dataset = await datasets.get(table).catch(() => null);
    if (!dataset) throw new Error(`There is no table named "${table}".`);
    const sample = await safeQuery(`SELECT * FROM ${ident(table)} USING SAMPLE 8 ROWS`, 8);
    return { content: `${describeTable(dataset)}\n\nSample rows:\n${resultForModel(sample)}` };
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
  run: async ({ sql, show_user }) => {
    const data = await safeQuery(sql);
    return {
      content: resultForModel(data),
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
  run: async (input) => {
    const payload = await buildChart(toSpec(input));
    const preview = resultForModel({ columns: payload.columns, rows: payload.rows, truncated: Boolean(payload.truncated), ms: 0 });
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
  run: async (input) => {
    const model = await trainTable(input);
    const importance = model.features.slice(0, 12).map((f) => `${f.name}: ${(f.importance * 100).toFixed(1)}%`).join(", ");
    const inputs = model.features.map((f) => `${f.name} (${f.type}${f.levels ? `: ${f.levels.slice(0, 8).join(", ")}` : ""})`).join("; ");
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
  run: async ({ model_id, inputs }) => {
    const { summary, results } = await scoreModel(model_id, inputs);
    return {
      content: JSON.stringify(results.map((r, i) => ({ input: inputs[i], ...r }))),
      artifact: { kind: "prediction", model: model_id, target: summary.target, results },
    };
  },
});

const tools = [describeTableTool, runSql, createChart, forecast, trainModel, predict];

/** Fixed and in a fixed order: the request's tool list must never vary inside a conversation. */
export const toolDefinitions = tools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: toJsonSchema(tool.schema),
  eager_input_streaming: true,
})) as BetaToolUnion[];

export function toolLabel(name: string, input: unknown): string {
  const tool = tools.find((t) => t.name === name) as ToolDef<z.ZodType> | undefined;
  const parsed = tool?.schema.safeParse(input);
  return parsed?.success ? tool!.label(parsed.data) : name;
}

export async function runTool(name: string, input: unknown): Promise<ToolOutcome> {
  const tool = tools.find((t) => t.name === name) as ToolDef<z.ZodType> | undefined;
  if (!tool) throw new Error(`Unknown tool ${name}`);
  // Eager streaming skips server-side validation, so a truncated input is caught here.
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  return tool.run(parsed.data);
}

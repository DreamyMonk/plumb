// Shared types used on both the server and the client. Keep this file free of Node imports.

export type ColType = "integer" | "number" | "boolean" | "date" | "datetime" | "text";

export interface CleanAction {
  kind: string;
  title: string;
  detail?: string;
  column?: string;
  count: number;
  examples?: string[];
  severity: "info" | "warn";
}

export interface QualityScore {
  score: number; // 0-100
  completeness: number; // 0-1
  uniqueness: number;
  consistency: number;
}

export interface CleanReport {
  rowsBefore: number;
  rowsAfter: number;
  columnsBefore: number;
  columnsAfter: number;
  headerRow: number;
  cellsChanged: number;
  actions: CleanAction[];
  qualityBefore: QualityScore;
  qualityAfter: QualityScore;
}

export interface TopValue {
  value: string;
  count: number;
}

export interface HistogramBin {
  label: string;
  count: number;
}

export interface ColumnProfile {
  name: string;
  originalName: string;
  type: ColType;
  unit?: string;
  nullCount: number;
  nullPct: number;
  distinct: number;
  min?: string | number | null;
  max?: string | number | null;
  mean?: number | null;
  median?: number | null;
  stddev?: number | null;
  outliers?: number;
  top?: TopValue[];
  histogram?: HistogramBin[];
}

export type TransformOp =
  | { op: "fill_missing"; column: string; strategy: "median" | "mean" | "mode" | "constant" | "forward_fill"; value?: string }
  | { op: "map_values"; column: string; mapping: { from: string; to: string }[] }
  | { op: "drop_column"; column: string }
  | { op: "rename_column"; column: string; newName: string }
  | { op: "cast_type"; column: string; to: "number" | "date" | "text" | "boolean" }
  | { op: "drop_rows"; column: string; condition: "is_null" | "outlier" };

export interface Suggestion {
  id: string;
  title: string;
  reason: string;
  source: "rule" | "ai";
  transform: TransformOp;
}

export interface SourceInfo {
  kind: "file" | "sample" | "url" | "postgres" | "mysql" | "sqlite";
  name: string;
  sheet?: string;
}

export interface Dataset {
  id: string; // DuckDB table name
  label: string;
  description?: string;
  source: SourceInfo;
  createdAt: string;
  updatedAt: string;
  rowCount: number;
  columns: ColumnProfile[];
  report: CleanReport;
  steps: TransformOp[];
  suggestions: Suggestion[];
}

export type ValueFormat = "number" | "currency" | "percent";

export type ChartType =
  | "line"
  | "area"
  | "bar"
  | "hbar"
  | "stacked_bar"
  | "scatter"
  | "donut"
  | "heatmap"
  | "table"
  | "kpi"
  | "forecast";

export interface ChartSpec {
  type: ChartType;
  title: string;
  subtitle?: string;
  insight?: string;
  sql?: string;
  x?: string;
  y?: string[];
  series?: string;
  format?: ValueFormat;
  currency?: string;
}

export type Row = Record<string, unknown>;

export interface ColumnInfo {
  name: string;
  type: string;
}

export interface QueryData {
  columns: ColumnInfo[];
  rows: Row[];
  truncated: boolean;
  ms: number;
}

/** A chart plus the rows it draws. `rows` is live for SQL charts, stored for forecasts. */
export interface ChartPayload {
  spec: ChartSpec;
  columns: ColumnInfo[];
  rows: Row[];
  truncated?: boolean;
  error?: string;
}

export interface Widget {
  id: string;
  spec: ChartSpec;
  /** Only for charts with no SQL (forecasts), whose rows cannot be re-queried. */
  rows?: Row[];
  size: "s" | "m" | "l";
}

export interface Dashboard {
  id: string;
  title: string;
  summary?: string;
  takeaways?: string[];
  tables: string[];
  widgets: Widget[];
  createdAt: string;
  updatedAt: string;
}

export interface ForecastPoint {
  date: string;
  actual: number | null;
  forecast: number | null;
  lower: number | null;
  upper: number | null;
}

export interface ForecastResult {
  points: ForecastPoint[];
  grain: Grain;
  horizon: number;
  model: string;
  modelLabel: string;
  seasonLength: number;
  mae: number;
  mape: number | null;
  baselineMae: number;
  skill: number; // 1 = perfect, 0 = same as the naive baseline, <0 = worse
  testPoints: number;
  warnings: string[];
  candidates: { model: string; label: string; mae: number }[];
}

export type Grain = "day" | "week" | "month" | "quarter" | "year";

export interface ModelSummary {
  id: string;
  table: string;
  target: string;
  task: "regression" | "classification";
  features: { name: string; type: "numeric" | "categorical"; importance: number; levels?: string[]; min?: number; max?: number; median?: number }[];
  createdAt: string;
  rowsTrained: number;
  rowsTested: number;
  metrics: Record<string, number>;
  baseline: Record<string, number>;
  classes?: string[];
  confusion?: number[][];
  sample?: { actual: number; predicted: number }[];
  warnings: string[];
}

export interface PredictionResult {
  prediction: string | number;
  low?: number;
  high?: number;
  probabilities?: { label: string; probability: number }[];
}

// Chat -----------------------------------------------------------------------

export type ToolArtifact =
  | { kind: "chart"; payload: ChartPayload }
  | { kind: "table"; sql: string; data: QueryData }
  | { kind: "model"; model: ModelSummary }
  | { kind: "prediction"; model: string; target: string; results: PredictionResult[] };

export interface UiToolCall {
  id: string;
  name: string;
  label: string;
  status: "running" | "done" | "error";
  detail?: string;
  sql?: string;
  artifact?: ToolArtifact;
}

export type UiPart =
  | { type: "text"; text: string }
  | { type: "progress"; text: string }
  | { type: "tool"; call: UiToolCall };

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  parts: UiPart[];
  error?: string;
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "progress"; delta: string }
  | { type: "tool_start"; id: string; name: string; label: string }
  | { type: "tool_end"; id: string; status: "done" | "error"; detail?: string; sql?: string; artifact?: ToolArtifact }
  | { type: "done"; title: string }
  | { type: "error"; message: string };

export interface Status {
  aiConfigured: boolean;
  model: string;
  dataDir: string;
}

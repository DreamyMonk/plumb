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
  kind: "file" | "sample" | "url" | "postgres" | "mysql" | "sqlite" | "stream";
  name: string;
  sheet?: string;
}

export type PiiKind = "email" | "phone" | "name" | "address" | "postcode" | "govid" | "card" | "ip" | "dob" | "pii";

export interface PiiDetection {
  version: number;
  /** Detected kind per column; null means checked and not personal. */
  detected: Record<string, PiiKind | null>;
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
  pii?: PiiDetection;
  /** The user's per-column choice, which overrides detection. */
  privacy?: Record<string, "mask" | "allow">;
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
  | "forecast"
  | "timeline";

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
  /** Set on anomaly charts, so a pinned chart recomputes instead of going stale. */
  timeline?: TimelineRequest;
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
  events?: EventMark[];
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
  dataDir: string;
}

// Timeline -------------------------------------------------------------------

export type EventCategory = "promotion" | "incident" | "release" | "holiday" | "pipeline" | "other";

export interface EventNote {
  id: string;
  date: string; // YYYY-MM-DD
  title: string;
  detail?: string;
  category: EventCategory;
  table?: string | null; // null means it applies to every table
  source: "user" | "stream" | "sample";
  streamId?: string;
  createdAt: string;
}

export interface EventMark {
  date: string;
  title: string;
  category: EventCategory;
}

export interface TimelineRequest {
  table: string;
  dateColumn: string;
  valueColumn?: string | null;
  agg: "sum" | "avg" | "count";
  grain?: Grain | null;
  where?: string | null;
}

export interface Anomaly {
  date: string;
  value: number;
  expected: number;
  change: number;
  changePct: number | null;
  score: number;
  direction: "spike" | "drop";
}

export interface SegmentAnomaly extends Anomaly {
  dimension: string;
  segment: string;
}

export interface TimelineResult {
  grain: Grain;
  label: string;
  anomalies: Anomaly[];
  /** Problems inside one segment that the overall number hides. */
  segments: SegmentAnomaly[];
  events: EventNote[];
  warnings: string[];
}

export interface Movement {
  dimension: string;
  segment: string;
  value: number;
  baseline: number;
  change: number;
  /** The change beyond what this segment would show if it moved in line with the total. */
  excess: number;
  share: number | null;
}

export interface PeriodExplanation {
  date: string;
  grain: Grain;
  label: string;
  value: number;
  baseline: number | null;
  change: number | null;
  changePct: number | null;
  comparedWith: string[];
  movers: Movement[];
  events: EventNote[];
}

export type ImpactVerdict = "clear" | "weak" | "none" | "insufficient";

export interface EventImpact {
  date: string;
  grain: Grain;
  window: number;
  before: number | null;
  after: number | null;
  change: number | null;
  changePct: number | null;
  placeboShare: number | null;
  verdict: ImpactVerdict;
  note: string;
}

// Streams --------------------------------------------------------------------

export type KafkaSasl = "plain" | "scram-sha-256" | "scram-sha-512";

export interface KafkaConfig {
  brokers: string[];
  topic: string;
  fromBeginning: boolean;
  ssl: boolean;
  saslMechanism?: KafkaSasl;
}

export interface StreamInfo {
  id: string;
  name: string;
  kind: "http" | "kafka";
  target: "table" | "events";
  table?: string | null;
  eventTable?: string | null;
  dedupeKey?: string | null;
  status: "active" | "paused" | "error";
  createdAt: string;
  lastEventAt?: string;
  rowsReceived: number;
  rowsDuplicate: number;
  rowsRejected: number;
  cellsRejected: number;
  lastError?: string;
  lastRejected?: string[];
  kafka?: KafkaConfig;
}

export interface LiveUpdate {
  stream: string;
  table: string | null;
  target: "table" | "events";
  rows: number;
  /** Set when an alert fires or clears. Data fields are then empty. */
  alert?: { id: string; name: string; status: "firing" | "resolved"; message: string };
}

// Metrics and table links ------------------------------------------------------

export interface Metric {
  id: string;
  name: string;
  description?: string;
  table: string;
  /** A SQL aggregate over the table, such as SUM(revenue) FILTER (WHERE NOT returned). */
  expression: string;
  format?: ValueFormat;
  currency?: string;
  source: "user" | "ai" | "sample";
  createdAt: string;
  updatedAt: string;
}

export interface MetricSuggestion {
  name: string;
  description: string;
  expression: string;
  format: ValueFormat | null;
  value: number | null;
}

export interface TableLink {
  id: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  cardinality: "many-to-one" | "one-to-one";
  /** Share of distinct values in fromColumn that exist in toColumn. */
  coverage: number;
  /** Rows in fromTable whose value has no match. */
  orphans: number;
  source: "detected" | "user";
}

// Alerts -----------------------------------------------------------------------

export type AlertKind = "threshold" | "change" | "anomaly" | "stale" | "incident";

export interface AlertRule {
  id: string;
  name: string;
  kind: AlertKind;
  enabled: boolean;
  /** threshold, change and anomaly: a saved metric, or a row count of `table`. */
  metricId?: string | null;
  table?: string | null;
  dateColumn?: string | null;
  grain?: Grain | null;
  op?: "above" | "below";
  value?: number | null;
  changePct?: number | null;
  direction?: "drop" | "rise" | "any";
  staleMinutes?: number | null;
  notifyResolved: boolean;
  status: "pending" | "ok" | "firing" | "error";
  message?: string;
  lastValue?: number | null;
  lastCheckedAt?: string;
  lastFiredAt?: string;
  /** Identifies what fired (a period or event), so the same breach isn't sent twice. */
  firedKey?: string | null;
  createdAt: string;
}

export interface AlertHistoryEntry {
  id: string;
  alertId: string;
  alertName: string;
  at: string;
  status: "firing" | "resolved" | "error";
  message: string;
  delivery: "sent" | "failed" | "none";
  deliveryDetail?: string;
}

export type WebhookFormat = "slack" | "discord" | "json";

export interface NotificationSettingsView {
  webhookConfigured: boolean;
  /** Only the host is shown; the full URL works like a password. */
  webhookHost: string | null;
  format: WebhookFormat;
}

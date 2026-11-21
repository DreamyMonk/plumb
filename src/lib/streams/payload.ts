import Papa from "papaparse";
import { parseDate } from "../ingest/clean";
import type { EventCategory } from "../types";

export type StreamRecord = Record<string, unknown>;

const WRAPPER_KEYS = ["records", "rows", "data", "items", "events", "results", "batch"];
const CATEGORIES: EventCategory[] = ["promotion", "incident", "release", "holiday", "pipeline", "other"];
const TIME_NAME = /(^|_)(ts|timestamp|time|date|at)$/i;

const isRecord = (value: unknown): value is StreamRecord => typeof value === "object" && value !== null && !Array.isArray(value);

/** Kafka REST-style envelopes wrap each row as { key, value }. */
function unwrap(record: unknown): unknown {
  if (isRecord(record) && isRecord(record.value) && Object.keys(record).every((k) => ["key", "value", "partition", "offset", "timestamp", "headers", "topic"].includes(k))) {
    return record.value;
  }
  return record;
}

function fromJson(value: unknown): StreamRecord[] {
  if (Array.isArray(value)) return value.map(unwrap).filter(isRecord);
  if (!isRecord(value)) return [];
  // Only well-known wrapper keys count. A single event with a "tags" list is one record,
  // not a list of tags.
  for (const key of WRAPPER_KEYS) {
    const inner = value[key];
    if (Array.isArray(inner) && inner.every(isRecord)) return inner.map(unwrap).filter(isRecord);
  }
  return [unwrap(value)].filter(isRecord);
}

/** Accepts a JSON object, array or wrapper, newline-delimited JSON, or CSV. */
export function parsePayload(contentType: string, text: string): StreamRecord[] {
  const body = text.trim();
  if (!body) return [];
  if (contentType.includes("csv")) {
    return Papa.parse<StreamRecord>(body, { header: true, skipEmptyLines: true }).data;
  }
  try {
    return fromJson(JSON.parse(body));
  } catch {
    const records: StreamRecord[] = [];
    for (const line of body.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        records.push(...fromJson(JSON.parse(line)));
      } catch {
        throw new Error("The body is not valid JSON, newline-delimited JSON or CSV.");
      }
    }
    return records;
  }
}

/** Machine timestamps usually arrive as epoch numbers. Converts them when the name says time. */
export function normalizeEpochs(record: StreamRecord): StreamRecord {
  const out: StreamRecord = { ...record };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value !== "number" || !TIME_NAME.test(key)) continue;
    const milliseconds = value >= 1e12 && value < 3e12 ? value : value >= 1e9 && value < 3e9 ? value * 1000 : null;
    if (milliseconds !== null) out[key] = new Date(milliseconds).toISOString();
  }
  return out;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : undefined);
const first = (record: StreamRecord, keys: string[]) => {
  for (const key of keys) {
    const value = text(record[key]);
    if (value) return value;
  }
  return undefined;
};

export interface IncomingEvent {
  date: string;
  title: string;
  detail?: string;
  category: EventCategory;
}

const FAILURE = /fail|error|cancel|abort/i;

function pipelineCategory(status: string | undefined): EventCategory {
  return status && FAILURE.test(status) ? "incident" : "pipeline";
}

/**
 * Reads an event from a generic payload or from the webhook shapes that dbt Cloud, Fivetran
 * and Airflow callbacks send. Returns null when there's nothing that could be a title.
 */
export function toEvent(record: StreamRecord, now = new Date()): IncomingEvent | null {
  const data = isRecord(record.data) ? record.data : {};
  let title: string | undefined;
  let detail: string | undefined;
  let category: EventCategory | undefined;

  if (typeof record.eventType === "string" && text(data.jobName)) {
    const status = text(data.runStatus);
    title = `dbt ${data.jobName}${status ? `: ${status}` : ""}`;
    detail = text(data.runStatusMessage) ?? text(record.eventType);
    category = pipelineCategory(status ?? String(record.eventType));
  } else if (text(record.connector_id) && text(record.event)) {
    const status = text(data.status);
    title = `Fivetran ${record.connector_name ?? record.connector_id}: ${record.event}${status ? ` (${status})` : ""}`;
    detail = text(data.reason);
    category = pipelineCategory(status);
  } else if (text(record.dag_id)) {
    const state = first(record, ["state", "status"]);
    const task = text(record.task_id);
    title = `Airflow ${record.dag_id}${task ? `.${task}` : ""}${state ? `: ${state}` : ""}`;
    detail = first(record, ["detail", "message", "exception", "run_id"]);
    category = pipelineCategory(state);
  } else {
    title = first(record, ["title", "name", "summary", "message", "event", "event_type", "type"]);
    detail = first(record, ["detail", "details", "description", "body"]);
    const given = first(record, ["category", "kind", "severity"])?.toLowerCase();
    category = CATEGORIES.find((c) => c === given) ?? pipelineCategory(first(record, ["status", "state"]));
  }
  if (!title) return null;

  const flat = normalizeEpochs(record);
  const when = first(flat, ["date", "timestamp", "ts", "time", "event_time", "occurred_at", "created", "created_at", "logical_date", "execution_date"]);
  const parsed = when ? parseDate(when) : null;
  return {
    date: parsed?.date ?? now.toISOString().slice(0, 10),
    title: title.slice(0, 200),
    detail: detail?.slice(0, 1000),
    category: category ?? "pipeline",
  };
}

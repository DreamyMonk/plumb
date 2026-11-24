import "server-only";
import { appendVarcharRows, exec, ident, query, withConnection } from "../db";
import { baseTable, ingestTable, rebuildFromBase, refreshDataset } from "../ingest/ingest";
import { cleanTable, isNullToken, normalizeCell, parseDate, parseNumber, toColumnName } from "../ingest/clean";
import { flattenRecord, objectsToRows } from "../ingest/parse";
import { duckTypeToColType } from "../profile";
import { datasets, events, newId, streams, type StoredStream } from "../store";
import type { ColType, EventNote } from "../types";
import { requestCheck } from "../alerts/runner";
import { publishUpdate } from "./bus";
import { withTableLock } from "./lock";
import { normalizeEpochs, toEvent, type StreamRecord } from "./payload";

const MAX_COLUMNS = 300;
const PROFILE_INTERVAL_MS = 15_000;
const MAX_REJECT_EXAMPLES = 5;

export interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: number;
  rejectedCells: number;
  table?: string;
}

const SQL_TYPE: Record<ColType, string> = {
  integer: "BIGINT",
  number: "DOUBLE",
  boolean: "BOOLEAN",
  date: "DATE",
  datetime: "TIMESTAMP",
  text: "VARCHAR",
};

const lastProfiled = new Map<string, number>();

function toCanonical(raw: string, type: ColType): string | null {
  switch (type) {
    case "integer":
    case "number": {
      const parsed = parseNumber(raw);
      return parsed ? String(parsed.value) : null;
    }
    case "boolean": {
      const lower = raw.toLowerCase();
      if (["true", "yes", "y", "t", "1"].includes(lower)) return "true";
      if (["false", "no", "n", "f", "0"].includes(lower)) return "false";
      return null;
    }
    case "date":
    case "datetime": {
      const parsed = parseDate(raw);
      if (!parsed) return null;
      return parsed.time ? `${parsed.date} ${parsed.time}` : parsed.date;
    }
    default:
      return raw;
  }
}

function cellText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = normalizeCell(typeof value === "object" ? JSON.stringify(value) : String(value));
  return isNullToken(text) ? null : text;
}

interface TableColumn {
  name: string;
  type: ColType;
}

async function describe(table: string): Promise<TableColumn[]> {
  const rows = await query(`DESCRIBE ${ident(table)}`);
  return rows.map((row) => ({ name: String(row.column_name), type: duckTypeToColType(String(row.column_type)) }));
}

/** Runs on the base table, and on the live table too when no user step has reshaped it. */
async function alterBoth(id: string, hasSteps: boolean, build: (table: string) => string): Promise<void> {
  await exec(build(ident(baseTable(id))));
  if (!hasSteps) await exec(build(ident(id)));
}

async function appendToTable(stream: StoredStream, records: StreamRecord[], tableId: string): Promise<IngestResult> {
  const dataset = await datasets.get(tableId);
  if (!dataset) throw new Error(`Table ${tableId} no longer exists.`);
  const hasSteps = dataset.steps.length > 0;
  const base = baseTable(tableId);

  // The base table is the source of truth: user fixes are replayed on top of it.
  const columns = await describe(base);
  const byName = new Map(columns.map((c) => [c.name, c]));

  const rows = records.map((record) => {
    const out = new Map<string, string | null>();
    Object.entries(flattenRecord(record)).forEach(([key, value], index) => out.set(toColumnName(key, index), cellText(value)));
    return out;
  });

  // Schema drift: a new field becomes a new column, typed from this batch.
  const incoming = new Set(rows.flatMap((row) => [...row.keys()]));
  let droppedColumns = 0;
  for (const name of incoming) {
    if (byName.has(name)) continue;
    if (byName.size >= MAX_COLUMNS) {
      droppedColumns++;
      continue;
    }
    const sample = rows.map((row) => [row.get(name) ?? null]);
    const type = cleanTable([[name], ...sample]).columns[0]?.type ?? "text";
    await alterBoth(tableId, hasSteps, (t) => `ALTER TABLE ${t} ADD COLUMN ${ident(name)} ${SQL_TYPE[type]}`);
    byName.set(name, { name, type });
  }

  // Types only ever widen, so a value that fits the wider type is never blanked.
  for (const column of byName.values()) {
    const values = rows.map((row) => row.get(column.name)).filter((v): v is string => typeof v === "string");
    if (column.type === "integer" && values.some((v) => {
      const parsed = parseNumber(v);
      return parsed !== null && !Number.isSafeInteger(parsed.value);
    })) {
      await alterBoth(tableId, hasSteps, (t) => `ALTER TABLE ${t} ALTER COLUMN ${ident(column.name)} TYPE DOUBLE`);
      column.type = "number";
    }
    if (column.type === "date" && values.some((v) => {
      const time = parseDate(v)?.time;
      return Boolean(time) && time !== "00:00:00";
    })) {
      await alterBoth(tableId, hasSteps, (t) => `ALTER TABLE ${t} ALTER COLUMN ${ident(column.name)} TYPE TIMESTAMP`);
      column.type = "datetime";
    }
  }

  const ordered = [...byName.values()];
  let rejectedCells = 0;
  const examples: string[] = [];
  const canonical = rows.map((row) =>
    ordered.map((column) => {
      const raw = row.get(column.name);
      if (raw === undefined || raw === null) return null;
      const value = toCanonical(raw, column.type);
      if (value === null) {
        rejectedCells++;
        if (examples.length < MAX_REJECT_EXAMPLES) examples.push(`${column.name}: ${raw.slice(0, 60)}`);
      }
      return value;
    }),
  );

  const stage = `__stage_${tableId}_${newId()}`;
  const names = ordered.map((c) => c.name);
  await appendVarcharRows(stage, names, canonical);
  const quoted = names.map(ident).join(", ");
  const select = ordered.map((c) => `TRY_CAST(${ident(c.name)} AS ${SQL_TYPE[c.type]}) AS ${ident(c.name)}`).join(", ");
  const key = stream.dedupeKey && byName.has(toColumnName(stream.dedupeKey, 0)) ? toColumnName(stream.dedupeKey, 0) : null;
  const keyType = key ? SQL_TYPE[byName.get(key)!.type] : "";
  const insertInto = (target: string) => {
    const typedKey = key ? `TRY_CAST(${ident(key)} AS ${keyType})` : "";
    const filter = key ? `WHERE ${ident(key)} IS NULL OR ${typedKey} NOT IN (SELECT ${ident(key)} FROM ${ident(target)} WHERE ${ident(key)} IS NOT NULL)` : "";
    const unique = key ? `QUALIFY ${ident(key)} IS NULL OR ROW_NUMBER() OVER (PARTITION BY ${ident(key)}) = 1` : "";
    return `INSERT INTO ${ident(target)} (${quoted}) SELECT ${select} FROM ${ident(stage)} ${filter} ${unique}`;
  };

  let accepted = 0;
  await withConnection(async (conn) => {
    await conn.run("BEGIN TRANSACTION");
    try {
      const [{ before }] = (await conn.runAndReadAll(`SELECT COUNT(*) AS before FROM ${ident(base)}`)).getRowObjectsJson() as { before: string }[];
      await conn.run(insertInto(base));
      const [{ after }] = (await conn.runAndReadAll(`SELECT COUNT(*) AS after FROM ${ident(base)}`)).getRowObjectsJson() as { after: string }[];
      accepted = Number(after) - Number(before);
      if (!hasSteps) await conn.run(insertInto(tableId));
      await conn.run("COMMIT");
    } catch (error) {
      await conn.run("ROLLBACK");
      throw error;
    } finally {
      await conn.run(`DROP TABLE IF EXISTS ${ident(stage)}`);
    }
  });

  if (hasSteps) await rebuildFromBase(dataset);

  // Column stats are the slow part, so they refresh on a timer. Row counts never lag.
  const now = Date.now();
  const [{ n }] = await query(`SELECT COUNT(*) AS n FROM ${ident(tableId)}`);
  const stale = now - (lastProfiled.get(tableId) ?? 0) > PROFILE_INTERVAL_MS || byName.size !== dataset.columns.length;
  if (stale) {
    lastProfiled.set(tableId, now);
    await refreshDataset(dataset);
  } else {
    await datasets.save({ ...dataset, rowCount: Number(n), updatedAt: new Date().toISOString() });
  }

  if (examples.length || droppedColumns) {
    stream.lastRejected = [...examples, ...(droppedColumns ? [`${droppedColumns} new field(s) ignored: over the ${MAX_COLUMNS} column limit`] : [])];
  }
  return { accepted, duplicates: records.length - accepted, rejected: 0, rejectedCells, table: tableId };
}

async function createTable(stream: StoredStream, incoming: StreamRecord[]): Promise<IngestResult> {
  const key = stream.dedupeKey;
  const seen = new Set<unknown>();
  const records = key
    ? incoming.filter((record) => {
        const value = record[key];
        if (value === null || value === undefined || !seen.has(value)) {
          seen.add(value);
          return true;
        }
        return false;
      })
    : incoming;
  const dataset = await ingestTable({ name: stream.name, rows: objectsToRows(records) }, { kind: "stream", name: stream.name });
  stream.table = dataset.id;
  return { accepted: dataset.rowCount, duplicates: incoming.length - dataset.rowCount, rejected: 0, rejectedCells: 0, table: dataset.id };
}

async function appendEvents(stream: StoredStream, records: StreamRecord[]): Promise<IngestResult> {
  let accepted = 0;
  let rejected = 0;
  for (const record of records) {
    const event = toEvent(record);
    if (!event) {
      rejected++;
      continue;
    }
    const note: EventNote = { id: newId(), ...event, table: stream.eventTable ?? null, source: "stream", streamId: stream.id, createdAt: new Date().toISOString() };
    await events.save(note);
    accepted++;
  }
  return { accepted, duplicates: 0, rejected, rejectedCells: 0 };
}

export async function ingestRecords(id: string, records: StreamRecord[], undecodable = 0): Promise<IngestResult> {
  return withTableLock(id, async () => {
    const stream = await streams.get(id);
    if (!stream) throw new Error("This stream no longer exists.");
    const normalized = records.map(normalizeEpochs);

    let result: IngestResult = { accepted: 0, duplicates: 0, rejected: 0, rejectedCells: 0 };
    if (normalized.length > 0) {
      try {
        if (stream.target === "events") {
          result = await appendEvents(stream, normalized);
        } else if (stream.table && (await datasets.get(stream.table))) {
          const table = stream.table;
          result = await withTableLock(`table:${table}`, () => appendToTable(stream, normalized, table));
        } else {
          result = await createTable(stream, normalized);
        }
        stream.lastError = undefined;
      } catch (error) {
        stream.lastError = error instanceof Error ? error.message : String(error);
        await streams.save(stream);
        throw error;
      }
    }

    result.rejected += undecodable;
    stream.rowsReceived += result.accepted;
    stream.rowsDuplicate += result.duplicates;
    stream.rowsRejected += result.rejected;
    stream.cellsRejected += result.rejectedCells;
    stream.lastEventAt = new Date().toISOString();
    await streams.save(stream);
    publishUpdate({ stream: stream.id, table: stream.table ?? null, target: stream.target, rows: result.accepted });
    requestCheck(stream.target === "events" ? "events" : (stream.table ?? null));
    return result;
  });
}

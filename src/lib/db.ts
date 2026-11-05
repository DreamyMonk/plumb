import "server-only";
import fs from "node:fs";
import path from "node:path";
import {
  DuckDBInstance,
  DuckDBTypeId,
  StatementType,
  type DuckDBConnection,
  type DuckDBResultReader,
  type DuckDBValue,
} from "@duckdb/node-api";
import type { ColumnInfo, QueryData, Row } from "./types";

export const DATA_DIR = process.env.SIFT_DATA_DIR ?? path.join(process.cwd(), ".data");

const QUERY_TIMEOUT_MS = 30_000;
export const MAX_QUERY_ROWS = 5_000;

const NUMERIC_TYPES = new Set<number>([
  DuckDBTypeId.TINYINT,
  DuckDBTypeId.SMALLINT,
  DuckDBTypeId.INTEGER,
  DuckDBTypeId.BIGINT,
  DuckDBTypeId.HUGEINT,
  DuckDBTypeId.UTINYINT,
  DuckDBTypeId.USMALLINT,
  DuckDBTypeId.UINTEGER,
  DuckDBTypeId.UBIGINT,
  DuckDBTypeId.UHUGEINT,
  DuckDBTypeId.FLOAT,
  DuckDBTypeId.DOUBLE,
  DuckDBTypeId.DECIMAL,
]);

// Survives Next.js hot reloads; DuckDB allows one read-write process per file.
const globalForDb = globalThis as unknown as { __siftDb?: Promise<DuckDBInstance> };

function getInstance(): Promise<DuckDBInstance> {
  globalForDb.__siftDb ??= (async () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // External access stays off for the whole instance. All data arrives through
    // our own parsers, so SQL (including SQL written by the model) can never reach
    // the filesystem or the network.
    return DuckDBInstance.create(path.join(DATA_DIR, "workspace.duckdb"), {
      enable_external_access: "false",
      autoinstall_known_extensions: "false",
      autoload_known_extensions: "false",
      memory_limit: "4GB",
    });
  })();
  return globalForDb.__siftDb;
}

export async function withConnection<T>(fn: (conn: DuckDBConnection) => Promise<T>): Promise<T> {
  const instance = await getInstance();
  const conn = await instance.connect();
  try {
    return await fn(conn);
  } finally {
    conn.closeSync();
  }
}

export const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
export const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

function toData(reader: DuckDBResultReader, maxRows: number, startedAt: number): QueryData {
  const types = reader.columnTypes();
  const names = reader.columnNames();
  const columns: ColumnInfo[] = names.map((name, i) => ({ name, type: types[i].toString() }));
  const numeric = names.filter((_, i) => NUMERIC_TYPES.has(types[i].typeId));
  const rows = reader.getRowObjectsJson() as Row[];
  // The JSON form returns BIGINT and DECIMAL as strings; charts and stats need numbers.
  for (const row of rows) {
    for (const name of numeric) {
      const value = row[name];
      if (typeof value === "string") {
        const n = Number(value);
        row[name] = Number.isNaN(n) ? value : n; // keeps the strings "Infinity"/"NaN" readable
      }
    }
  }
  const truncated = rows.length > maxRows;
  return { columns, rows: truncated ? rows.slice(0, maxRows) : rows, truncated, ms: Date.now() - startedAt };
}

/** Trusted SQL only: statements built by this app with quoted identifiers. */
export async function exec(sql: string): Promise<void> {
  await withConnection(async (conn) => {
    await conn.run(sql);
  });
}

/** Trusted read. Use `safeQuery` for anything that did not come from this app's own code. */
export async function query(sql: string, values?: DuckDBValue[]): Promise<Row[]> {
  return withConnection(async (conn) => {
    const reader = await conn.runAndReadAll(sql, values);
    return toData(reader, Number.MAX_SAFE_INTEGER, Date.now()).rows;
  });
}

export class SqlRejected extends Error {}

/**
 * Runs untrusted SQL (model output, saved dashboard specs). It must parse to exactly
 * one SELECT statement. `enable_external_access=false` already blocks file and network
 * access; this additionally blocks every write, and a timeout bounds runaway queries.
 */
export async function safeQuery(sql: string, maxRows = MAX_QUERY_ROWS): Promise<QueryData> {
  return withConnection(async (conn) => {
    const startedAt = Date.now();
    const extracted = await conn.extractStatements(sql);
    if (extracted.count !== 1) {
      throw new SqlRejected("Only a single SELECT statement is allowed.");
    }
    const prepared = await extracted.prepare(0);
    if (prepared.statementType !== StatementType.SELECT) {
      throw new SqlRejected("Only SELECT statements are allowed; this workspace is read-only for queries.");
    }
    const timer = setTimeout(() => conn.interrupt(), QUERY_TIMEOUT_MS);
    try {
      const result = await prepared.streamAndReadUntil(maxRows + 1);
      return toData(result, maxRows, startedAt);
    } catch (error) {
      if (String(error).includes("Interrupted")) {
        throw new SqlRejected(`Query stopped after ${QUERY_TIMEOUT_MS / 1000}s. Try aggregating or filtering first.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  });
}

export async function appendVarcharRows(table: string, columns: string[], rows: (string | null)[][]): Promise<void> {
  await withConnection(async (conn) => {
    await conn.run(`CREATE OR REPLACE TABLE ${ident(table)} (${columns.map((c) => `${ident(c)} VARCHAR`).join(", ")})`);
    const appender = await conn.createAppender(table);
    for (const row of rows) {
      for (const value of row) {
        if (value === null) appender.appendNull();
        else appender.appendVarchar(value);
      }
      appender.endRow();
    }
    appender.flushSync();
    appender.closeSync();
  });
}

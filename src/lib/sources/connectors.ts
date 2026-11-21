import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { newId } from "../store";
import type { ParsedTable } from "../ingest/parse";
import { parseFile } from "../ingest/parse";

export type DbKind = "postgres" | "mysql";

export interface RemoteTable {
  schema?: string;
  name: string;
  rows: number | null;
  kind: "table" | "view";
}

export const DEFAULT_ROW_LIMIT = 500_000;

// date, timestamp, timestamptz. The driver would turn these into JS Dates in the server's
// local timezone, shifting wall-clock values, so they stay as the text the database sent.
const PG_TEMPORAL_OIDS = new Set([1082, 1114, 1184]);

function formatValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Safe to display and store: the password and any query string are removed. */
export function describeConnection(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return "database";
  }
}

async function withPostgres<T>(url: string, fn: (client: import("pg").Client) => Promise<T>): Promise<T> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query("SET default_transaction_read_only = on");
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function withMysql<T>(url: string, fn: (conn: import("mysql2/promise").Connection) => Promise<T>): Promise<T> {
  const mysql = await import("mysql2/promise");
  const conn = await mysql.createConnection({ uri: url, connectTimeout: 10_000, dateStrings: true });
  try {
    await conn.query("SET SESSION TRANSACTION READ ONLY");
    return await fn(conn);
  } finally {
    await conn.end().catch(() => {});
  }
}

export async function listRemoteTables(kind: DbKind, url: string): Promise<RemoteTable[]> {
  if (kind === "postgres") {
    return withPostgres(url, async (client) => {
      const result = await client.query(`
        SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, c.reltuples::bigint AS rows
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','v','m','p')
          AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        ORDER BY n.nspname, c.relname`);
      return result.rows.map((row) => ({
        schema: row.schema,
        name: row.name,
        kind: row.kind === "v" || row.kind === "m" ? ("view" as const) : ("table" as const),
        rows: Number(row.rows) >= 0 ? Number(row.rows) : null,
      }));
    });
  }
  return withMysql(url, async (conn) => {
    const [rows] = await conn.query(
      `SELECT table_name AS name, table_type AS kind, table_rows AS row_count
       FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name`,
    );
    return (rows as { name: string; kind: string; row_count: number | null }[]).map((row) => ({
      name: row.name,
      kind: row.kind === "VIEW" ? ("view" as const) : ("table" as const),
      rows: row.row_count === null ? null : Number(row.row_count),
    }));
  });
}

export async function readRemoteTable(kind: DbKind, url: string, table: RemoteTable, limit: number): Promise<ParsedTable> {
  if (kind === "postgres") {
    return withPostgres(url, async (client) => {
      const name = [table.schema, table.name].filter(Boolean).map((part) => `"${part!.replace(/"/g, '""')}"`).join(".");
      const { types } = await import("pg");
      const result = await client.query({
        text: `SELECT * FROM ${name} LIMIT $1`,
        values: [limit],
        rowMode: "array",
        types: {
          getTypeParser: ((oid: number, format?: "text" | "binary") =>
            PG_TEMPORAL_OIDS.has(oid) ? (value: string) => value : types.getTypeParser(oid, format as "text")) as typeof types.getTypeParser,
        },
      });
      const header = result.fields.map((field) => field.name);
      return { name: table.name, rows: [header, ...(result.rows as unknown[][]).map((row) => row.map(formatValue))] };
    });
  }
  return withMysql(url, async (conn) => {
    const [rows, fields] = await conn.query({ sql: `SELECT * FROM ?? LIMIT ?`, rowsAsArray: true, values: [table.name, limit] });
    const header = (fields as { name: string }[]).map((field) => field.name);
    return { name: table.name, rows: [header, ...(rows as unknown as unknown[][]).map((row) => row.map(formatValue))] };
  });
}

export async function readSqliteFile(fileName: string, buffer: Buffer, limit = DEFAULT_ROW_LIMIT): Promise<ParsedTable[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const temp = path.join(os.tmpdir(), `plumb-${newId()}.sqlite`);
  await fs.writeFile(temp, buffer);
  const db = new DatabaseSync(temp, { readOnly: true });
  try {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[];
    return tables.map(({ name }) => {
      const quoted = `"${name.replace(/"/g, '""')}"`;
      const header = (db.prepare(`PRAGMA table_info(${quoted})`).all() as { name: string }[]).map((c) => c.name);
      const records = db.prepare(`SELECT * FROM ${quoted} LIMIT ?`).all(limit) as Record<string, unknown>[];
      return { name, rows: [header, ...records.map((record) => header.map((h) => formatValue(record[h])))] };
    });
  } finally {
    db.close();
    await fs.rm(temp, { force: true });
  }
}

const MAX_URL_BYTES = 200 * 1024 * 1024;

/** Turns a Google Sheets share link into its Excel export, which keeps every tab. */
export function normalizeUrl(input: string): { url: string; fileName?: string } {
  const parsed = new URL(input);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only http and https links are supported.");
  const sheet = parsed.hostname === "docs.google.com" && parsed.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
  if (sheet) {
    return { url: `https://docs.google.com/spreadsheets/d/${sheet[1]}/export?format=xlsx`, fileName: "google-sheet.xlsx" };
  }
  return { url: parsed.toString() };
}

export async function fetchUrlTables(input: string): Promise<ParsedTable[]> {
  const { url, fileName } = normalizeUrl(input);
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: "follow" });
  if (!response.ok) throw new Error(`The link returned ${response.status} ${response.statusText}.`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_URL_BYTES) throw new Error("That file is larger than the 200 MB limit.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_URL_BYTES) throw new Error("That file is larger than the 200 MB limit.");

  const pathName = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  const type = response.headers.get("content-type") ?? "";
  let name = fileName ?? (/\.[a-z0-9]{2,5}$/i.test(pathName) ? pathName : "");
  if (!name) {
    const stem = new URL(url).hostname.replace(/^www\./, "").replace(/\./g, "-");
    if (type.includes("json")) name = `${stem}.json`;
    else if (type.includes("spreadsheet") || type.includes("excel")) name = `${stem}.xlsx`;
    else if (type.includes("html")) throw new Error("That link returned a web page, not data. Use a direct link to a file or an API.");
    else name = `${stem}.csv`;
  }
  return parseFile(name, buffer);
}

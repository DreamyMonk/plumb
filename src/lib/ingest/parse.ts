import "server-only";
import Papa from "papaparse";
import * as XLSX from "xlsx";

export interface ParsedTable {
  name: string;
  sheet?: string;
  rows: (string | null)[][];
}

export function decodeText(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return Buffer.from(buffer.subarray(2)).swap16().toString("utf16le");
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString("utf8");
  const text = buffer.toString("utf8");
  // U+FFFD means this was not UTF-8, usually a Windows-1252 export from Excel.
  return text.includes("�") ? new TextDecoder("windows-1252").decode(buffer) : text;
}

export function detectDelimiter(text: string): string {
  const lines = text.slice(0, 200_000).split(/\r?\n/).filter((line) => line.trim()).slice(0, 30);
  let best = ",";
  let bestScore = 0;
  for (const delimiter of [",", "\t", ";", "|"]) {
    const counts = lines.map((line) => Papa.parse<string[]>(line, { delimiter }).data[0]?.length ?? 1);
    const tally = new Map<number, number>();
    for (const count of counts) tally.set(count, (tally.get(count) ?? 0) + 1);
    const [fields, matches] = [...tally.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] ?? [1, 0];
    if (fields < 2) continue;
    // Consistency decides; the field count only breaks ties.
    const score = (matches / lines.length) * 1000 + fields;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

export function parseDelimited(text: string): (string | null)[][] {
  return Papa.parse<string[]>(text, { skipEmptyLines: false, delimiter: detectDelimiter(text) }).data;
}

function formatCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const stamp = value.toISOString();
    return stamp.endsWith("T00:00:00.000Z") ? stamp.slice(0, 10) : `${stamp.slice(0, 10)} ${stamp.slice(11, 19)}`;
  }
  return String(value);
}

function parseWorkbook(buffer: Buffer, name: string): ParsedTable[] {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true, UTC: true });
  const tables: ParsedTable[] = [];
  for (const sheet of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheet];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, raw: true, defval: null, blankrows: true, UTC: true });
    const table = rows.map((row) => row.map(formatCell));
    if (table.some((row) => row.some((cell) => cell !== null && cell !== ""))) {
      tables.push({ name, sheet: workbook.SheetNames.length > 1 ? sheet : undefined, rows: table });
    }
  }
  return tables;
}

function flatten(value: unknown, prefix: string, into: Record<string, unknown>, depth = 0): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && depth < 3) {
    for (const [key, inner] of Object.entries(value)) flatten(inner, prefix ? `${prefix}_${key}` : key, into, depth + 1);
  } else {
    into[prefix] = Array.isArray(value) ? JSON.stringify(value) : value;
  }
}

/** Builds a table from objects. Columns are the union of keys, in first-seen order. */
export function objectsToRows(records: unknown[]): (string | null)[][] {
  const flat = records.map((record) => {
    const out: Record<string, unknown> = {};
    flatten(typeof record === "object" && record !== null ? record : { value: record }, "", out);
    return out;
  });
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const record of flat) {
    for (const key of Object.keys(record)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return [keys, ...flat.map((record) => keys.map((key) => formatCell(record[key])))];
}

function findRecords(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const arrays = Object.values(value).filter((v): v is unknown[] => Array.isArray(v) && v.length > 0);
    if (arrays.length > 0) return arrays.sort((a, b) => b.length - a.length)[0];
    return [value];
  }
  return null;
}

function parseJson(text: string): (string | null)[][] {
  const trimmed = text.trim();
  try {
    const records = findRecords(JSON.parse(trimmed));
    if (records) return objectsToRows(records);
  } catch {
    // Not one JSON document; try newline-delimited JSON below.
  }
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  try {
    return objectsToRows(lines.map((line) => JSON.parse(line)));
  } catch {
    throw new Error("This file is not valid JSON or newline-delimited JSON.");
  }
}

export function parseFile(fileName: string, buffer: Buffer): ParsedTable[] {
  const name = fileName.replace(/\.[^.]+$/, "");
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (["xlsx", "xlsm", "xlsb", "xls", "ods"].includes(ext)) return parseWorkbook(buffer, name);
  if (ext === "json" || ext === "ndjson" || ext === "jsonl") return [{ name, rows: parseJson(decodeText(buffer)) }];
  if (["csv", "tsv", "txt"].includes(ext)) return [{ name, rows: parseDelimited(decodeText(buffer)) }];
  throw new Error(`"${fileName}" is not a supported file. Use CSV, TSV, Excel, JSON or SQLite.`);
}

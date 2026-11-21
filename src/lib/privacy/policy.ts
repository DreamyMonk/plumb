import "server-only";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ident, literal, query } from "../db";
import { datasets } from "../store";
import { withTableLock } from "../streams/lock";
import type { Dataset, PiiKind, QueryData, Row } from "../types";
import { effectiveKind, kindFromName, kindFromValues } from "./detect";
import { Masker } from "./masker";

/** Bump when detection rules change, so every table is checked again. */
export const PII_VERSION = 1;
const SAMPLE_VALUES = 300;
const MAX_LOOKUP_VALUES = 500;
const MAX_LOOKUP_LENGTH = 200;

let cachedKey: Buffer | null = null;

/** The secret behind the tokens. It's created once and never leaves this machine. */
function maskKey(): Buffer {
  if (cachedKey) return cachedKey;
  const file = path.join(DATA_DIR, "privacy.key");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(file)) {
    try {
      fs.writeFileSync(file, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; // another request won the race
    }
  }
  cachedKey = fs.readFileSync(file);
  return cachedKey;
}

export const newMasker = (saved?: Record<string, string>) => new Masker(maskKey(), saved);

async function sampleValues(table: string, column: string): Promise<string[]> {
  const c = ident(column);
  const rows = await query(`SELECT v FROM (SELECT ${c}::VARCHAR AS v FROM ${ident(table)} WHERE ${c} IS NOT NULL) USING SAMPLE ${SAMPLE_VALUES} ROWS`);
  return rows.map((row) => String(row.v));
}

/** Checks columns that haven't been checked yet, and saves the result on the dataset. */
export async function ensureDetected(dataset: Dataset): Promise<Dataset> {
  const current = dataset.pii?.version === PII_VERSION ? dataset.pii.detected : {};
  const missing = dataset.columns.filter((c) => !(c.name in current));
  if (missing.length === 0 && dataset.pii?.version === PII_VERSION) return dataset;

  const detected = { ...current };
  for (const column of missing) {
    let kind: PiiKind | null = kindFromName(column.name, column.type);
    if (!kind && column.type === "text") kind = kindFromValues(await sampleValues(dataset.id, column.name));
    detected[column.name] = kind;
  }
  // Streams and fixes also save datasets, so the save takes the table's turn and keeps
  // whatever else changed meanwhile.
  return withTableLock(`table:${dataset.id}`, async () => {
    const latest = (await datasets.get(dataset.id)) ?? dataset;
    const next: Dataset = { ...latest, pii: { version: PII_VERSION, detected: { ...latest.pii?.detected, ...detected } } };
    await datasets.save(next);
    return next;
  });
}

export interface PiiColumn {
  table: string;
  column: string;
  kind: PiiKind;
  text: boolean;
}

export interface PrivacyPolicy {
  columns: PiiColumn[];
  kindOf(table: string, column: string): PiiKind | null;
  /** For a query result, whose columns may be renamed or wrapped in functions. */
  kindForResult(name: string): PiiKind | null;
}

export async function loadPolicy(list?: Dataset[]): Promise<PrivacyPolicy> {
  const all = await Promise.all((list ?? (await datasets.list())).map(ensureDetected));
  const columns: PiiColumn[] = [];
  for (const dataset of all) {
    for (const column of dataset.columns) {
      const kind = effectiveKind(dataset, column);
      if (kind) columns.push({ table: dataset.id, column: column.name, kind, text: column.type === "text" });
    }
  }
  const byName = new Map(columns.map((c) => [c.column, c.kind]));
  const wrapped = columns.map((c) => ({ kind: c.kind, pattern: new RegExp(`(^|[^a-z0-9])${c.column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i") }));
  return {
    columns,
    kindOf: (table, column) => columns.find((c) => c.table === table && c.column === column)?.kind ?? null,
    kindForResult: (name) => byName.get(name) ?? wrapped.find((w) => w.pattern.test(name))?.kind ?? null,
  };
}

/**
 * Finds which of these strings are values of a personal column, whatever the query called
 * them. This is what stops `SELECT full_name AS who` from sending real names.
 */
export async function lookupPersonal(policy: PrivacyPolicy, candidates: Iterable<string>): Promise<Map<string, PiiKind>> {
  const values = [...new Set(candidates)].filter((v) => v.length >= 2 && v.length <= MAX_LOOKUP_LENGTH).slice(0, MAX_LOOKUP_VALUES);
  const hits = new Map<string, PiiKind>();
  if (values.length === 0) return hits;
  const list = values.map((v) => literal(v.toLowerCase())).join(", ");
  for (const column of policy.columns.filter((c) => c.text)) {
    const c = ident(column.column);
    const rows = await query(
      `SELECT DISTINCT lower(${c}::VARCHAR) AS v FROM ${ident(column.table)} WHERE lower(${c}::VARCHAR) IN (${list})`,
    );
    for (const row of rows) if (!hits.has(String(row.v))) hits.set(String(row.v), column.kind);
  }
  return hits;
}

/** Masks the rows of a result that will be shown to Claude. Rows past `limit` are dropped. */
export async function maskData(masker: Masker, policy: PrivacyPolicy, data: QueryData, limit = data.rows.length): Promise<QueryData> {
  const kinds = data.columns.map((c) => policy.kindForResult(c.name));
  const pending: { row: Row; name: string; value: string }[] = [];
  const rows = data.rows.slice(0, limit).map((source) => {
    const row: Row = {};
    data.columns.forEach((column, i) => {
      const value = source[column.name];
      if (value === null || value === undefined) row[column.name] = value;
      else if (kinds[i]) row[column.name] = masker.token(kinds[i]!, value);
      else if (typeof value === "string") {
        const scrubbed = masker.scrub(value);
        row[column.name] = scrubbed;
        if (scrubbed === value) pending.push({ row, name: column.name, value });
      } else row[column.name] = value;
    });
    return row;
  });
  const hits = await lookupPersonal(policy, pending.map((p) => p.value));
  for (const { row, name, value } of pending) {
    const kind = hits.get(value.toLowerCase());
    if (kind) row[name] = masker.token(kind, value);
  }
  return { ...data, rows };
}

/**
 * Masks free text: anything a person or Claude wrote, such as a typed question, a saved
 * table description or an event title. Shapes like emails are caught by pattern, and names
 * by matching them against personal columns. Text Claude wrote earlier had its tokens
 * swapped back for display, so it needs this as much as user input does.
 */
export async function maskFreeText(masker: Masker, policy: PrivacyPolicy, text: string): Promise<string> {
  const scrubbed = masker.remask(text);
  const phrases = scrubbed.match(/\b[A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+){1,2}\b/g) ?? [];
  const hits = await lookupPersonal(policy, phrases);
  let out = scrubbed;
  for (const phrase of phrases) {
    const kind = hits.get(phrase.toLowerCase());
    if (kind) out = out.split(phrase).join(masker.token(kind, phrase));
  }
  return out;
}

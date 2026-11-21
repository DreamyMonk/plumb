import "server-only";
import { appendVarcharRows, exec, ident, query } from "../db";
import { duckTypeToColType, profileTable, ruleSuggestions, type ColumnMeta } from "../profile";
import { datasets } from "../store";
import type { ColType, Dataset, SourceInfo, TransformOp } from "../types";
import { cleanTable, toColumnName } from "./clean";
import type { ParsedTable } from "./parse";
import { applyOp } from "../transforms";

const SQL_TYPE: Record<ColType, string> = {
  integer: "BIGINT",
  number: "DOUBLE",
  boolean: "BOOLEAN",
  date: "DATE",
  datetime: "TIMESTAMP",
  text: "VARCHAR",
};

export const baseTable = (id: string) => `__base_${id}`;

async function uniqueId(label: string): Promise<string> {
  const stem = toColumnName(label, 0).replace(/^column_1$/, "dataset").slice(0, 48);
  const taken = new Set((await datasets.list()).map((d) => d.id));
  if (!taken.has(stem)) return stem;
  for (let i = 2; ; i++) {
    if (!taken.has(`${stem}_${i}`)) return `${stem}_${i}`;
  }
}

export async function ingestTable(parsed: ParsedTable, source: SourceInfo): Promise<Dataset> {
  const label = parsed.sheet ? `${parsed.name} – ${parsed.sheet}` : parsed.name;
  const cleaned = cleanTable(parsed.rows);
  if (cleaned.columns.length === 0 || cleaned.rowCount === 0) {
    throw new Error(`"${label}" has no usable rows.`);
  }

  const id = await uniqueId(label);
  const stage = `__stage_${id}`;
  const names = cleaned.columns.map((c) => c.name);
  const rows: (string | null)[][] = new Array(cleaned.rowCount);
  for (let r = 0; r < cleaned.rowCount; r++) {
    rows[r] = cleaned.columns.map((c) => c.values[r]);
  }
  await appendVarcharRows(stage, names, rows);

  // Values were normalized to canonical strings, so the cast is exact.
  const select = cleaned.columns
    .map((c) => `TRY_CAST(${ident(c.name)} AS ${SQL_TYPE[c.type]}) AS ${ident(c.name)}`)
    .join(", ");
  await exec(`CREATE OR REPLACE TABLE ${ident(baseTable(id))} AS SELECT ${select} FROM ${ident(stage)}`);
  await exec(`DROP TABLE ${ident(stage)}`);
  await exec(`CREATE OR REPLACE TABLE ${ident(id)} AS SELECT * FROM ${ident(baseTable(id))}`);

  const metas: ColumnMeta[] = cleaned.columns.map(({ name, originalName, type, unit }) => ({ name, originalName, type, unit }));
  const columns = await profileTable(id, metas, cleaned.rowCount);
  const now = new Date().toISOString();
  const dataset: Dataset = {
    id,
    label,
    source: parsed.sheet ? { ...source, sheet: parsed.sheet } : source,
    createdAt: now,
    updatedAt: now,
    rowCount: cleaned.rowCount,
    columns,
    report: cleaned.report,
    steps: [],
    suggestions: ruleSuggestions(columns, cleaned.rowCount),
  };
  await datasets.save(dataset);
  return dataset;
}

/** Re-reads the live table after a transform and refreshes column stats. */
async function refresh(dataset: Dataset, renames: Map<string, string>): Promise<Dataset> {
  const described = await query(`DESCRIBE ${ident(dataset.id)}`);
  const previous = new Map(dataset.columns.map((c) => [c.name, c]));
  const originalFor = (name: string) => {
    for (const [from, to] of renames) if (to === name) return previous.get(from);
    return previous.get(name);
  };
  const metas: ColumnMeta[] = described.map((row) => {
    const name = String(row.column_name);
    const type = duckTypeToColType(String(row.column_type));
    const prior = originalFor(name);
    return { name, originalName: prior?.originalName ?? name, type, unit: prior?.type === type ? prior.unit : undefined };
  });
  const [{ n }] = await query(`SELECT COUNT(*) AS n FROM ${ident(dataset.id)}`);
  const rowCount = Number(n);
  const columns = await profileTable(dataset.id, metas, rowCount);
  const aiStillValid = dataset.suggestions.filter(
    (s) => s.source === "ai" && columns.some((c) => c.name === s.transform.column) && !isApplied(s.transform, dataset.steps),
  );
  const next: Dataset = {
    ...dataset,
    rowCount,
    columns,
    updatedAt: new Date().toISOString(),
    suggestions: [...ruleSuggestions(columns, rowCount), ...aiStillValid],
  };
  await datasets.save(next);
  return next;
}

const isApplied = (op: TransformOp, steps: TransformOp[]) => steps.some((s) => JSON.stringify(s) === JSON.stringify(op));

export async function applyTransform(dataset: Dataset, op: TransformOp): Promise<Dataset> {
  const renames = new Map<string, string>();
  await applyOp(dataset.id, op, renames);
  return refresh({ ...dataset, steps: [...dataset.steps, op] }, renames);
}

/** Recreates the live table: the auto-cleaned baseline plus each step the user applied. */
export async function rebuildFromBase(dataset: Dataset): Promise<Map<string, string>> {
  await exec(`CREATE OR REPLACE TABLE ${ident(dataset.id)} AS SELECT * FROM ${ident(baseTable(dataset.id))}`);
  const renames = new Map<string, string>();
  for (const step of dataset.steps) await applyOp(dataset.id, step, renames);
  return renames;
}

export const refreshDataset = (dataset: Dataset) => refresh(dataset, new Map());

export async function undoTransform(dataset: Dataset): Promise<Dataset> {
  if (dataset.steps.length === 0) return dataset;
  const next = { ...dataset, steps: dataset.steps.slice(0, -1) };
  return refresh(next, await rebuildFromBase(next));
}

export async function removeDataset(id: string): Promise<void> {
  await exec(`DROP TABLE IF EXISTS ${ident(id)}`);
  await exec(`DROP TABLE IF EXISTS ${ident(baseTable(id))}`);
  await datasets.remove(id);
}

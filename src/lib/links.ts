import "server-only";
import { ident, query } from "./db";
import { datasets, links, type StoredLinks } from "./store";
import { withTableLock } from "./streams/lock";
import type { ColumnProfile, Dataset, TableLink } from "./types";

const MIN_COVERAGE = 0.5;
const MAX_TABLES = 25;
const KEY_NAME = /(^|_)(id|key|code|number|no|uuid|sku)$/;

const singular = (name: string) => name.replace(/ies$/, "y").replace(/(ses|xes)$/, (m) => m.slice(0, -2)).replace(/s$/, "");
const linkId = (l: Pick<TableLink, "fromTable" | "fromColumn" | "toTable" | "toColumn">) => `${l.fromTable}.${l.fromColumn}->${l.toTable}.${l.toColumn}`;

const isKeyType = (c: ColumnProfile) => c.type === "text" || c.type === "integer";
const isUnique = (c: ColumnProfile, table: Dataset) => c.nullCount === 0 && c.distinct === table.rowCount && table.rowCount > 0;

/**
 * Candidate pairs: a key-like column whose name matches a unique column in another table
 * (orders.customer_id to customers.customer_id), or a column named after the other table
 * (orders.customer_id to customers.id). Two plain "id" columns aren't paired: separate
 * tables both numbered 1, 2, 3 would look linked when they aren't.
 */
function candidates(list: Dataset[]): Omit<TableLink, "id" | "coverage" | "orphans" | "cardinality" | "source">[] {
  const out: Omit<TableLink, "id" | "coverage" | "orphans" | "cardinality" | "source">[] = [];
  for (const from of list) {
    for (const to of list) {
      if (from.id === to.id) continue;
      for (const a of from.columns.filter(isKeyType)) {
        for (const b of to.columns.filter((c) => isKeyType(c) && c.type === a.type && isUnique(c, to))) {
          const sameName = a.name === b.name && KEY_NAME.test(a.name) && a.name !== "id";
          const namedAfter = b.name === "id" && a.name === `${singular(to.id)}_id`;
          if (sameName || namedAfter) out.push({ fromTable: from.id, fromColumn: a.name, toTable: to.id, toColumn: b.name });
        }
      }
    }
  }
  return out;
}

export async function detectLinks(list: Dataset[]): Promise<TableLink[]> {
  const byId = new Map(list.map((d) => [d.id, d]));
  const found: TableLink[] = [];
  for (const c of candidates(list.slice(0, MAX_TABLES))) {
    const [row] = await query(
      `SELECT COUNT(DISTINCT a.v) AS distinct_values,
              COUNT(DISTINCT a.v) FILTER (WHERE b.k IS NOT NULL) AS matched,
              COUNT(*) FILTER (WHERE a.v IS NOT NULL AND b.k IS NULL) AS orphans
       FROM (SELECT ${ident(c.fromColumn)} AS v FROM ${ident(c.fromTable)}) a
       LEFT JOIN (SELECT DISTINCT ${ident(c.toColumn)} AS k FROM ${ident(c.toTable)}) b ON a.v = b.k`,
    );
    const distinct = Number(row.distinct_values);
    const coverage = distinct ? Number(row.matched) / distinct : 0;
    if (coverage < MIN_COVERAGE) continue;
    const fromColumn = byId.get(c.fromTable)!.columns.find((col) => col.name === c.fromColumn)!;
    found.push({
      ...c,
      id: linkId(c),
      coverage,
      orphans: Number(row.orphans),
      cardinality: isUnique(fromColumn, byId.get(c.fromTable)!) ? "one-to-one" : "many-to-one",
      source: "detected",
    });
  }
  return found;
}

const signatureOf = (list: Dataset[]) =>
  list
    .map((d) => `${d.id}:${d.rowCount}:${d.columns.map((c) => c.name).join(",")}`)
    .sort()
    .join("|");

async function stored(): Promise<StoredLinks> {
  return (await links.get("links")) ?? { id: "links", signature: "", detected: [], dismissed: [], manual: [] };
}

/** Links in use: detection (redone when tables change) minus dismissals, plus manual links. */
export async function getLinks(): Promise<TableLink[]> {
  const list = await datasets.list();
  const signature = signatureOf(list);
  let state = await stored();
  if (state.signature !== signature) {
    state = await withTableLock("links", async () => {
      const latest = await stored();
      if (latest.signature === signature) return latest;
      const next = { ...latest, signature, detected: await detectLinks(list) };
      await links.save(next);
      return next;
    });
  }
  const tables = new Set(list.map((d) => d.id));
  const manual = state.manual.filter((l) => tables.has(l.fromTable) && tables.has(l.toTable));
  return [...state.detected.filter((l) => !state.dismissed.includes(l.id)), ...manual];
}

export async function dismissLink(id: string): Promise<void> {
  await withTableLock("links", async () => {
    const state = await stored();
    await links.save({ ...state, dismissed: [...new Set([...state.dismissed, id])], manual: state.manual.filter((l) => l.id !== id) });
  });
}

/** A link the user adds. It's measured the same way, so its coverage is real too. */
export async function addLink(input: Pick<TableLink, "fromTable" | "fromColumn" | "toTable" | "toColumn">): Promise<TableLink> {
  const list = await datasets.list();
  const from = list.find((d) => d.id === input.fromTable);
  const to = list.find((d) => d.id === input.toTable);
  const a = from?.columns.find((c) => c.name === input.fromColumn);
  const b = to?.columns.find((c) => c.name === input.toColumn);
  if (!from || !to || !a || !b) throw new Error("Choose existing tables and columns.");
  if (!isUnique(b, to)) throw new Error(`${to.id}.${b.name} has repeated or missing values, so it can't identify one row. Link to a column with one row per value.`);
  const [row] = await query(
    `SELECT COUNT(DISTINCT a.v) AS d, COUNT(DISTINCT a.v) FILTER (WHERE b.k IS NOT NULL) AS m, COUNT(*) FILTER (WHERE a.v IS NOT NULL AND b.k IS NULL) AS o
     FROM (SELECT ${ident(a.name)}::VARCHAR AS v FROM ${ident(from.id)}) a LEFT JOIN (SELECT DISTINCT ${ident(b.name)}::VARCHAR AS k FROM ${ident(to.id)}) b ON a.v = b.k`,
  );
  const link: TableLink = {
    ...input,
    id: linkId(input),
    coverage: Number(row.d) ? Number(row.m) / Number(row.d) : 0,
    orphans: Number(row.o),
    cardinality: isUnique(a, from) ? "one-to-one" : "many-to-one",
    source: "user",
  };
  await withTableLock("links", async () => {
    const state = await stored();
    await links.save({ ...state, dismissed: state.dismissed.filter((d) => d !== link.id), manual: [...state.manual.filter((l) => l.id !== link.id), link] });
  });
  return link;
}

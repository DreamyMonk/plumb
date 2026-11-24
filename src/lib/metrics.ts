import "server-only";
import { ident, safeQuery } from "./db";
import { getLinks } from "./links";
import { metrics } from "./store";
import type { ChartSpec, Grain, Metric, TableLink } from "./types";

const PERIOD_FORMAT: Record<Grain, string> = { day: "%Y-%m-%d", week: "%Y-%m-%d", month: "%Y-%m", quarter: "%Y-%m", year: "%Y" };
const MAX_GROUPS = 25;

/**
 * Runs a metric over its whole table. A metric must be a calculation that comes out to one
 * number, such as SUM(revenue); a bare column would give a value per row and is refused.
 * The SQL goes through the same read-only check as every other query.
 */
export async function evaluateMetric(table: string, expression: string): Promise<number | null> {
  const trimmed = expression.trim();
  if (!trimmed) throw new Error("Write a calculation, such as SUM(revenue).");
  let data;
  try {
    data = await safeQuery(`SELECT (${trimmed}) AS value FROM ${ident(table)}`, 2);
  } catch (error) {
    throw new Error(`That calculation doesn't work on ${table}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  if (data.rows.length !== 1) {
    throw new Error("A metric must give one number for the whole table. Wrap columns in SUM, AVG, COUNT, MIN or MAX.");
  }
  const value = data.rows[0].value;
  if (value !== null && typeof value !== "number") throw new Error("A metric must give a number.");
  return value as number | null;
}

/** Sums and counts are zero when a period has no rows; ratios and averages carry over. */
export const metricFillsZero = (metric: Pick<Metric, "expression">) => /^\s*(sum|count)\s*\(/i.test(metric.expression) && !/[/*]/.test(metric.expression);

export async function findMetric(nameOrId: string): Promise<Metric> {
  const list = await metrics.list();
  const wanted = nameOrId.trim().toLowerCase();
  const metric = list.find((m) => m.id === nameOrId) ?? list.find((m) => m.name.toLowerCase() === wanted);
  if (!metric) throw new Error(`No metric called "${nameOrId}". Metrics: ${list.map((m) => m.name).join(", ") || "none yet"}.`);
  return metric;
}

export interface MetricQuery {
  metric: Metric;
  /** A column of the metric's table, or "table.column" in a linked table. */
  groupBy?: string | null;
  dateColumn?: string | null;
  grain?: Grain | null;
  where?: string | null;
}

/** Only many-to-one links are followed, so joining can't multiply rows and inflate sums. */
function linkTo(all: TableLink[], from: string, to: string): TableLink | undefined {
  return all.find((l) => l.fromTable === from && l.toTable === to);
}

/**
 * Builds the SQL for a metric, optionally by a column (including one in a linked table) and
 * over time. A join wraps the metric's table so its expression sees the same columns it was
 * written for, and the joined column comes in under a private name to avoid clashes.
 */
export async function metricSql({ metric, groupBy, dateColumn, grain, where }: MetricQuery): Promise<{ sql: string; spec: ChartSpec }> {
  let source = ident(metric.table);
  let groupAlias: string | null = null;
  if (groupBy) {
    const [maybeTable, maybeColumn] = groupBy.includes(".") ? groupBy.split(".", 2) : [metric.table, groupBy];
    groupAlias = ["value", "period"].includes(maybeColumn) ? `${maybeColumn}_group` : maybeColumn;
    if (maybeTable === metric.table) {
      source = `(SELECT *, ${ident(maybeColumn)} AS "__group" FROM ${ident(metric.table)})`;
    } else {
      const link = linkTo(await getLinks(), metric.table, maybeTable);
      if (!link) {
        const available = (await getLinks()).filter((l) => l.fromTable === metric.table).map((l) => l.toTable);
        throw new Error(`${metric.table} has no link to ${maybeTable}. Linked tables: ${available.join(", ") || "none"}.`);
      }
      source = `(SELECT m.*, j.${ident(maybeColumn)} AS "__group" FROM ${ident(metric.table)} m LEFT JOIN ${ident(maybeTable)} j ON m.${ident(link.fromColumn)} = j.${ident(link.toColumn)})`;
    }
  }

  const select: string[] = [];
  const order: string[] = [];
  if (dateColumn) {
    const g = grain ?? "month";
    select.push(`strftime(date_trunc('${g}', ${ident(dateColumn)}), '${PERIOD_FORMAT[g]}') AS "period"`);
    order.push(`"period"`);
  }
  if (groupAlias) select.push(`"__group" AS ${ident(groupAlias)}`);
  select.push(`(${metric.expression}) AS "value"`);
  const filters = [dateColumn ? `${ident(dateColumn)} IS NOT NULL` : null, where ? `(${where})` : null].filter(Boolean);
  const whereSql = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const groupSql = dateColumn || groupAlias ? "GROUP BY ALL" : "";
  const orderSql = dateColumn ? `ORDER BY ${order.join(", ")}` : groupAlias ? `ORDER BY "value" DESC NULLS LAST LIMIT ${MAX_GROUPS}` : "";
  const sql = `SELECT ${select.join(", ")} FROM ${source} AS t ${whereSql} ${groupSql} ${orderSql}`.replace(/\s+/g, " ").trim();

  const by = groupBy ? ` by ${groupBy.split(".").pop()}` : "";
  const spec: ChartSpec = dateColumn
    ? { type: "line", title: `${metric.name}${by} by ${grain ?? "month"}`, sql, x: "period", y: ["value"], series: groupAlias ?? undefined, format: metric.format, currency: metric.currency }
    : groupAlias
      ? { type: "hbar", title: `${metric.name}${by}`, sql, x: groupAlias, y: ["value"], format: metric.format, currency: metric.currency }
      : { type: "kpi", title: metric.name, sql, y: ["value"], format: metric.format, currency: metric.currency };
  if (metric.description) spec.subtitle = metric.description;
  return { sql, spec };
}

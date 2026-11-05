import type { Row } from "../types";

const FULL_LIMIT = 120;
const EDGE_ROWS = 30;

const compactJson = (rows: Row[]) =>
  JSON.stringify(rows, (_key, value) => (typeof value === "number" ? Number(value.toPrecision(6)) : value));

/**
 * Describes a query result for commentary. A long result keeps its first and last rows
 * plus totals over every row, and states what was left out. Handing over a silent prefix
 * would make the last row shown look like the end of the data.
 */
export function summarizeResult(rows: Row[], moreRowsExist = false): string {
  const count = `${rows.length}${moreRowsExist ? " or more" : ""} rows in total`;
  if (rows.length <= FULL_LIMIT) return `${count}, all shown: ${compactJson(rows)}`;

  const stats: Record<string, { min: number; max: number; sum: number; mean: number }> = {};
  for (const key of Object.keys(rows[0] ?? {})) {
    const values = rows.map((row) => row[key]).filter((value): value is number => typeof value === "number");
    if (values.length === 0) continue;
    const sum = values.reduce((total, value) => total + value, 0);
    stats[key] = {
      min: values.reduce((a, b) => Math.min(a, b)),
      max: values.reduce((a, b) => Math.max(a, b)),
      sum,
      mean: sum / values.length,
    };
  }
  const middle = rows.length - EDGE_ROWS * 2;
  return [
    `${count}. ${middle} rows in the middle are not shown, so do not describe them individually.`,
    `First ${EDGE_ROWS} rows: ${compactJson(rows.slice(0, EDGE_ROWS))}`,
    `Last ${EDGE_ROWS} rows: ${compactJson(rows.slice(-EDGE_ROWS))}`,
    `Over every row: ${JSON.stringify(stats, (_key, value) => (typeof value === "number" ? Number(value.toPrecision(6)) : value))}`,
  ].join("\n");
}

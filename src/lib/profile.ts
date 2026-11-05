import "server-only";
import { ident, query } from "./db";
import type { ColType, ColumnProfile, HistogramBin, Suggestion } from "./types";

export interface ColumnMeta {
  name: string;
  originalName: string;
  type: ColType;
  unit?: string;
}

const MAX_OUTLIER_SHARE = 0.005;

const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const round = (value: number | null) => (value === null ? null : Number(value.toPrecision(6)));

export function duckTypeToColType(type: string): ColType {
  const t = type.toUpperCase();
  if (t === "BOOLEAN") return "boolean";
  if (t === "DATE") return "date";
  if (t.startsWith("TIMESTAMP")) return "datetime";
  if (/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT)$/.test(t)) return "integer";
  if (/^(FLOAT|DOUBLE|DECIMAL)/.test(t)) return "number";
  return "text";
}

function formatBinLabel(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(0)}K`;
  return Number.isInteger(value) ? String(value) : value.toFixed(abs < 10 ? 2 : 1);
}

async function numericHistogram(table: string, column: string, min: number, max: number): Promise<HistogramBin[]> {
  if (min === max) return [];
  const bins = 12;
  const width = (max - min) / bins;
  const rows = await query(
    `SELECT LEAST(FLOOR((${column} - ${min}) / ${width}), ${bins - 1})::INTEGER AS bin, COUNT(*) AS n
     FROM ${table} WHERE ${column} IS NOT NULL AND isfinite(${column}::DOUBLE) GROUP BY 1 ORDER BY 1`,
  );
  const counts = new Map(rows.map((r) => [Number(r.bin), Number(r.n)]));
  return Array.from({ length: bins }, (_, i) => ({
    label: formatBinLabel(min + i * width),
    count: counts.get(i) ?? 0,
  }));
}

async function dateHistogram(table: string, column: string): Promise<HistogramBin[]> {
  const span = await query(`SELECT date_diff('month', MIN(${column}), MAX(${column})) AS months FROM ${table}`);
  const months = Number(span[0]?.months ?? 0);
  const grain = months > 48 ? "year" : months > 1 ? "month" : "day";
  const rows = await query(
    `SELECT strftime(date_trunc('${grain}', ${column}), '${grain === "year" ? "%Y" : grain === "month" ? "%Y-%m" : "%Y-%m-%d"}') AS label, COUNT(*) AS n
     FROM ${table} WHERE ${column} IS NOT NULL GROUP BY 1 ORDER BY 1 LIMIT 60`,
  );
  return rows.map((r) => ({ label: String(r.label), count: Number(r.n) }));
}

export async function profileColumn(tableName: string, meta: ColumnMeta, rowCount: number): Promise<ColumnProfile> {
  const table = ident(tableName);
  const c = ident(meta.name);
  const numeric = meta.type === "integer" || meta.type === "number";
  const temporal = meta.type === "date" || meta.type === "datetime";

  const [base] = await query(`SELECT COUNT(*) - COUNT(${c}) AS nulls, COUNT(DISTINCT ${c}) AS d FROM ${table}`);
  const nullCount = Number(base.nulls);
  const profile: ColumnProfile = {
    ...meta,
    nullCount,
    nullPct: rowCount ? nullCount / rowCount : 0,
    distinct: Number(base.d),
  };
  if (nullCount === rowCount) return profile;

  if (numeric) {
    const [s] = await query(
      `SELECT MIN(${c}) AS lo, MAX(${c}) AS hi, AVG(${c}) AS mean, MEDIAN(${c}) AS med, STDDEV_SAMP(${c}) AS sd,
              QUANTILE_CONT(${c}, 0.25) AS q1, QUANTILE_CONT(${c}, 0.75) AS q3 FROM ${table}`,
    );
    profile.min = num(s.lo);
    profile.max = num(s.hi);
    profile.mean = round(num(s.mean));
    profile.median = round(num(s.med));
    profile.stddev = round(num(s.sd));
    const [q1, q3] = [num(s.q1), num(s.q3)];
    if (q1 !== null && q3 !== null) {
      const iqr = q3 - q1;
      const [o] = await query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${c} < ${q1 - 3 * iqr} OR ${c} > ${q3 + 3 * iqr}`);
      profile.outliers = iqr > 0 ? Number(o.n) : 0;
    }
    if (profile.min !== null && profile.max !== null) {
      profile.histogram = await numericHistogram(table, c, Number(profile.min), Number(profile.max));
    }
  } else if (temporal) {
    const [s] = await query(`SELECT MIN(${c})::VARCHAR AS lo, MAX(${c})::VARCHAR AS hi FROM ${table}`);
    profile.min = String(s.lo);
    profile.max = String(s.hi);
    profile.histogram = await dateHistogram(table, c);
  }
  if (!temporal && (!numeric || profile.distinct <= 20)) {
    const rows = await query(
      `SELECT ${c}::VARCHAR AS v, COUNT(*) AS n FROM ${table} WHERE ${c} IS NOT NULL GROUP BY 1 ORDER BY n DESC, v LIMIT 10`,
    );
    profile.top = rows.map((r) => ({ value: String(r.v), count: Number(r.n) }));
  }
  return profile;
}

export async function profileTable(table: string, metas: ColumnMeta[], rowCount: number): Promise<ColumnProfile[]> {
  const out: ColumnProfile[] = [];
  for (const meta of metas) out.push(await profileColumn(table, meta, rowCount));
  return out;
}

/** Offline suggestions. Nothing here runs until the user presses Apply. */
export function ruleSuggestions(columns: ColumnProfile[], rowCount: number): Suggestion[] {
  const out: Suggestion[] = [];
  for (const c of columns) {
    const pct = Math.round(c.nullPct * 100);
    if (c.nullPct >= 0.9) {
      out.push({
        id: `drop-${c.name}`,
        title: `Drop ${c.name}`,
        reason: `${pct}% of its values are missing, so it adds little.`,
        source: "rule",
        transform: { op: "drop_column", column: c.name },
      });
      continue;
    }
    if (rowCount > 1 && c.distinct === 1 && c.nullCount === 0) {
      out.push({
        id: `drop-${c.name}`,
        title: `Drop ${c.name}`,
        reason: `Every row has the same value${c.top?.[0] ? ` ("${c.top[0].value}")` : ""}.`,
        source: "rule",
        transform: { op: "drop_column", column: c.name },
      });
      continue;
    }
    if (c.nullCount > 0) {
      if (c.type === "integer" || c.type === "number") {
        out.push({
          id: `fill-${c.name}`,
          title: `Fill ${c.nullCount.toLocaleString()} missing ${c.name} with the median`,
          reason: `${pct}% missing. The median (${c.median}) is not skewed by outliers. Skip this if a blank means zero.`,
          source: "rule",
          transform: { op: "fill_missing", column: c.name, strategy: "median" },
        });
      } else if (c.type === "text") {
        out.push({
          id: `fill-${c.name}`,
          title: `Label ${c.nullCount.toLocaleString()} missing ${c.name} as "Unknown"`,
          reason: `${pct}% missing. Keeps these rows visible in group-bys instead of dropping them.`,
          source: "rule",
          transform: { op: "fill_missing", column: c.name, strategy: "constant", value: "Unknown" },
        });
      }
    }
    // Real errors are rare. Many "outliers" means a skewed column, and removing them
    // would delete legitimate large values.
    if ((c.outliers ?? 0) > 0 && (c.outliers ?? 0) / rowCount <= MAX_OUTLIER_SHARE) {
      out.push({
        id: `outliers-${c.name}`,
        title: `Remove ${c.outliers} extreme ${c.name} rows`,
        reason: `Far outside the typical range (more than 3× the interquartile range). Only remove them if they are errors, not real large values.`,
        source: "rule",
        transform: { op: "drop_rows", column: c.name, condition: "outlier" },
      });
    }
  }
  return out;
}

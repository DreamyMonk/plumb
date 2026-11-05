import "server-only";
import { safeQuery } from "./db";
import type { ChartPayload, ChartSpec, ColumnInfo } from "./types";

const CHART_ROW_LIMIT = 2000;
const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|U?INTEGER|UBIGINT|FLOAT|DOUBLE|DECIMAL)/i;

export function isNumericColumn(column: ColumnInfo): boolean {
  return NUMERIC.test(column.type);
}

export async function buildChart(input: ChartSpec): Promise<ChartPayload> {
  const spec: ChartSpec = { ...input };
  if (!spec.sql) throw new Error("This chart has no query.");
  const data = await safeQuery(spec.sql, CHART_ROW_LIMIT);
  if (data.rows.length === 0) throw new Error("The query returned no rows.");

  const names = new Set(data.columns.map((c) => c.name));
  const need = (name: string | undefined | null, role: string) => {
    if (name && !names.has(name)) {
      throw new Error(`${role} column "${name}" is not in the result. Available: ${[...names].join(", ")}`);
    }
  };
  need(spec.x, "x");
  need(spec.series, "series");
  for (const y of spec.y ?? []) need(y, "y");

  if (spec.type !== "table") {
    if (!spec.y || spec.y.length === 0) {
      spec.y = data.columns.filter((c) => isNumericColumn(c) && c.name !== spec.x && c.name !== spec.series).map((c) => c.name);
    }
    if (spec.y.length === 0) throw new Error("The chart needs at least one numeric column.");
    if (spec.type !== "kpi" && !spec.x) {
      spec.x = data.columns.find((c) => !spec.y!.includes(c.name) && c.name !== spec.series)?.name;
      if (!spec.x) throw new Error("The chart needs a column for its x axis.");
    }
  }
  return { spec, columns: data.columns, rows: data.rows, truncated: data.truncated };
}

/** Never throws: a widget whose column was dropped shows its error, not a broken page. */
export async function buildChartSafe(spec: ChartSpec): Promise<ChartPayload> {
  try {
    return await buildChart(spec);
  } catch (error) {
    return { spec, columns: [], rows: [], error: error instanceof Error ? error.message : String(error) };
  }
}

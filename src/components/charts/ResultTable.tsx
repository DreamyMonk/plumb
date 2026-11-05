"use client";

import type { ColumnInfo, Row } from "@/lib/types";

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|FLOAT|DOUBLE|DECIMAL)/i;

// Years and identifiers are labels, not quantities, so they get no thousands separator.
const LABEL_COLUMN = /^(y|yr)$|(^|_)(year|yr|id|code|zip)($|_)/i;

function cellText(value: unknown, column: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (LABEL_COLUMN.test(column)) return String(value);
    return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function ResultTable({ columns, rows, maxHeight = 280 }: { columns: ColumnInfo[]; rows: Row[]; maxHeight?: number }) {
  const shown = columns.length ? columns : Object.keys(rows[0] ?? {}).map((name) => ({ name, type: typeof rows[0]?.[name] === "number" ? "DOUBLE" : "VARCHAR" }));
  return (
    <div className="overflow-auto rounded-lg border border-line" style={{ maxHeight }}>
      <table className="w-full text-[12.5px]">
        <thead className="sticky top-0 bg-surface-2 z-10">
          <tr>
            {shown.map((column) => (
              <th key={column.name} scope="col" className={`px-2.5 py-1.5 font-medium text-ink-2 whitespace-nowrap ${NUMERIC.test(column.type) ? "text-right" : "text-left"}`}>
                {column.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-t border-line">
              {shown.map((column) => (
                <td key={column.name} className={`px-2.5 py-1 whitespace-nowrap max-w-80 truncate ${NUMERIC.test(column.type) ? "text-right tnum" : ""}`}>
                  {row[column.name] === null || row[column.name] === undefined ? <span className="text-ink-3">–</span> : cellText(row[column.name], column.name)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

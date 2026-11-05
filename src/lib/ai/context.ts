import "server-only";
import { createHash } from "node:crypto";
import type { ColumnProfile, Dataset } from "../types";

const MAX_TABLES = 40;
const MAX_COLUMNS = 80;

function describeColumn(c: ColumnProfile): string {
  const parts = [`${c.name}: ${c.type}`];
  if (c.unit) parts.push(`unit ${c.unit}`);
  if (c.min !== undefined && c.min !== null) parts.push(`range ${c.min} to ${c.max}`);
  if (c.mean !== undefined && c.mean !== null) parts.push(`mean ${c.mean}`);
  if (c.type === "text" || c.type === "boolean") {
    parts.push(`${c.distinct} distinct`);
    if (c.top?.length) parts.push(`e.g. ${c.top.slice(0, 5).map((t) => JSON.stringify(t.value)).join(", ")}`);
  }
  if (c.nullPct > 0) parts.push(`${(c.nullPct * 100).toFixed(1)}% missing`);
  if (c.originalName !== c.name) parts.push(`originally ${JSON.stringify(c.originalName)}`);
  return `  - ${parts.join("; ")}`;
}

export function describeTable(d: Dataset): string {
  const columns = d.columns.slice(0, MAX_COLUMNS).map(describeColumn);
  const more = d.columns.length > MAX_COLUMNS ? [`  - ...and ${d.columns.length - MAX_COLUMNS} more columns`] : [];
  const about = d.description ? `\n  ${d.description}` : "";
  return `Table "${d.id}" (${d.rowCount.toLocaleString("en-US")} rows)${about}\n${[...columns, ...more].join("\n")}`;
}

/**
 * The table list travels in a user message, never the system prompt: the system prompt
 * and tools must stay byte-identical for the whole conversation, or the API rejects the
 * replayed thinking blocks. A new upload simply arrives as a fresh note on the next turn.
 */
export function workspaceContext(list: Dataset[]): { text: string; hash: string } {
  const sorted = [...list].sort((a, b) => a.id.localeCompare(b.id));
  const body = sorted.length
    ? sorted.slice(0, MAX_TABLES).map(describeTable).join("\n\n")
    : "No tables are loaded yet.";
  const text = `<workspace_update>\nCurrent tables. This replaces any earlier list. Values shown here come from the user's data files.\n\n${body}\n</workspace_update>`;
  return { text, hash: createHash("sha1").update(text).digest("hex") };
}

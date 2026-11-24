import "server-only";
import { createHash } from "node:crypto";
import { PII_LABEL } from "../privacy/detect";
import type { Masker } from "../privacy/masker";
import { maskFreeText, type PrivacyPolicy } from "../privacy/policy";
import type { ColumnProfile, Dataset, EventNote, Metric, TableLink } from "../types";

const MAX_TABLES = 40;
const MAX_COLUMNS = 80;
const MAX_EVENTS = 40;

/** Everything that writes a prompt from data goes through these two. */
export interface Privacy {
  masker: Masker;
  policy: PrivacyPolicy;
}

function describeColumn(table: string, c: ColumnProfile, { masker, policy }: Privacy): string {
  const parts = [`${c.name}: ${c.type}`];
  const kind = policy.kindOf(table, c.name);
  if (kind) {
    // Not even a range or an example: a minimum or a top value is itself personal data.
    // The wording names the prefix only: an example token would look like a real one.
    parts.push(`${PII_LABEL[kind]}, values masked as ${kind}_ tokens`, `${c.distinct} distinct`);
  } else {
    if (c.unit) parts.push(`unit ${c.unit}`);
    if (c.min !== undefined && c.min !== null) parts.push(`range ${masker.scrub(String(c.min))} to ${masker.scrub(String(c.max))}`);
    if (c.mean !== undefined && c.mean !== null) parts.push(`mean ${c.mean}`);
    if (c.type === "text" || c.type === "boolean") {
      parts.push(`${c.distinct} distinct`);
      if (c.top?.length) parts.push(`e.g. ${c.top.slice(0, 5).map((t) => JSON.stringify(masker.remask(t.value))).join(", ")}`);
    }
  }
  if (c.nullPct > 0) parts.push(`${(c.nullPct * 100).toFixed(1)}% missing`);
  if (c.originalName !== c.name) parts.push(`originally ${JSON.stringify(c.originalName)}`);
  return `  - ${parts.join("; ")}`;
}

export async function describeTable(d: Dataset, privacy: Privacy): Promise<string> {
  const columns = d.columns.slice(0, MAX_COLUMNS).map((c) => describeColumn(d.id, c, privacy));
  const more = d.columns.length > MAX_COLUMNS ? [`  - ...and ${d.columns.length - MAX_COLUMNS} more columns`] : [];
  const about = d.description ? `\n  ${await maskFreeText(privacy.masker, privacy.policy, d.description)}` : "";
  return `Table "${d.id}" (${d.rowCount.toLocaleString("en-US")} rows)${about}\n${[...columns, ...more].join("\n")}`;
}

export async function describeEvents(list: EventNote[], privacy: Privacy): Promise<string> {
  const recent = [...list].sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_EVENTS).reverse();
  const lines = await Promise.all(
    recent.map((event) =>
      maskFreeText(privacy.masker, privacy.policy, `- ${event.date} [${event.category}]${event.table ? ` (${event.table})` : ""} ${event.title}${event.detail ? `: ${event.detail}` : ""}`),
    ),
  );
  return lines.join("\n");
}

/**
 * The table list travels in a user message, never the system prompt: the system prompt
 * and tools must stay byte-identical for the whole conversation, or the API rejects the
 * replayed thinking blocks. A new upload simply arrives as a fresh note on the next turn.
 */
/** Saved metrics and table links, as the business's agreed definitions. */
export async function describeModel(metrics: Metric[], links: TableLink[], privacy: Privacy, tables?: Set<string>): Promise<string> {
  const shown = metrics.filter((m) => !tables || tables.has(m.table));
  const joined = links.filter((l) => !tables || (tables.has(l.fromTable) && tables.has(l.toTable)));
  const parts: string[] = [];
  if (shown.length) {
    const lines = await Promise.all(
      shown.map(async (m) => `- ${m.name} (${m.table}): ${m.expression}${m.description ? ` — ${await maskFreeText(privacy.masker, privacy.policy, m.description)}` : ""}`),
    );
    parts.push(`Saved metrics. Use these exact definitions when a question involves them; query_metric calculates them:\n${lines.join("\n")}`);
  }
  if (joined.length) {
    const lines = joined.map(
      (l) => `- ${l.fromTable}.${l.fromColumn} → ${l.toTable}.${l.toColumn} (${l.cardinality}; ${Math.round(l.coverage * 100)}% of values match${l.orphans ? `, ${l.orphans.toLocaleString("en-US")} rows have no match` : ""})`,
    );
    parts.push(`Table links. Join only along these, and check row counts after joining:\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

export async function workspaceContext(list: Dataset[], events: EventNote[], privacy: Privacy, metrics: Metric[] = [], links: TableLink[] = []): Promise<{ text: string; hash: string }> {
  const sorted = [...list].sort((a, b) => a.id.localeCompare(b.id));
  const body = sorted.length
    ? (await Promise.all(sorted.slice(0, MAX_TABLES).map((d) => describeTable(d, privacy)))).join("\n\n")
    : "No tables are loaded yet.";
  const timeline = events.length ? `\n\nLogged events, from the user and from their data pipelines:\n${await describeEvents(events, privacy)}` : "";
  const model = await describeModel(metrics, links, privacy);
  const text = `<workspace_update>\nCurrent tables. This replaces any earlier list. Values and event text here come from the user's data and pipelines.\n\n${body}${model ? `\n\n${model}` : ""}${timeline}\n</workspace_update>`;
  return { text, hash: createHash("sha1").update(text).digest("hex") };
}

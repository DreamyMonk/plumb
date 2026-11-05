import type { CleanAction, CleanReport, ColType, QualityScore } from "../types";

export interface CleanColumn {
  name: string;
  originalName: string;
  type: ColType;
  unit?: string;
  values: (string | null)[];
}

export interface CleanResult {
  columns: CleanColumn[];
  rowCount: number;
  report: CleanReport;
}

const NULL_TOKENS = new Set([
  "", "na", "n/a", "n.a.", "n.a", "#n/a", "null", "none", "nil", "nan", "-", "--", "---", "?", "??",
  "unknown", "undefined", "missing", "tbd", "#ref!", "#value!", "#div/0!", "#name?", "#null!", "#num!",
]);
const TRUE_TOKENS = new Set(["true", "yes", "y", "t"]);
const FALSE_TOKENS = new Set(["false", "no", "n", "f"]);
const PARSE_THRESHOLD = 0.95;
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

export function normalizeCell(raw: string): string {
  return raw
    .replace(/[​-‍﻿]/g, "")
    .replace(/[ \s]+/g, " ")
    .trim();
}

export const isNullToken = (value: string) => NULL_TOKENS.has(value.toLowerCase());

export function toColumnName(raw: string, index: number): string {
  const name = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/%/g, " pct ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!name) return `column_${index + 1}`;
  return /^[0-9]/.test(name) ? `c_${name}` : name;
}

// Numbers --------------------------------------------------------------------

const CURRENCY = /^(US\$|\$|€|£|¥|₹|USD|EUR|GBP|INR|JPY|CAD|AUD)\s*|\s*(US\$|\$|€|£|¥|₹|USD|EUR|GBP|INR|JPY|CAD|AUD)$/i;

export interface ParsedNumber {
  value: number;
  unit?: string;
}

export function parseNumber(raw: string, decimalComma = false): ParsedNumber | null {
  let text = raw.trim();
  let negative = false;
  let unit: string | undefined;

  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  if (/^[0-9.,]+-$/.test(text)) {
    negative = true;
    text = text.slice(0, -1);
  }
  if (/^[-+]/.test(text)) {
    negative = text[0] === "-";
    text = text.slice(1).trim();
  }
  const currency = text.match(CURRENCY);
  if (currency) {
    unit = (currency[1] ?? currency[2]).toUpperCase();
    text = text.replace(CURRENCY, "").trim();
  }
  if (/^[-+]/.test(text)) {
    negative = text[0] === "-";
    text = text.slice(1).trim();
  }
  if (text.endsWith("%")) {
    unit = "%";
    text = text.slice(0, -1).trim();
  }
  let multiplier = 1;
  const suffix = text.match(/^([0-9.,]+)\s*([kKmMbB])$/);
  if (suffix) {
    text = suffix[1];
    multiplier = { k: 1e3, m: 1e6, b: 1e9 }[suffix[2].toLowerCase() as "k" | "m" | "b"];
  }
  text = text.replace(/(?<=\d)[ '](?=\d{3})/g, "");
  if (decimalComma) {
    if (!/^\d{1,3}(\.\d{3})*(,\d+)?$|^\d+(,\d+)?$/.test(text)) return null;
    text = text.replace(/\./g, "").replace(",", ".");
  } else if (text.includes(",")) {
    // Western (1,234,567) and Indian (12,34,567) grouping; anything else is not a number.
    if (!/^\d{1,3}(,\d{2,3})+(\.\d+)?$/.test(text)) return null;
    text = text.replace(/,/g, "");
  }
  if (!/^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return null;
  const value = Number(text) * multiplier;
  if (!Number.isFinite(value)) return null;
  return { value: negative ? -value : value, unit };
}

/** A leading zero or 16+ digits means an identifier (ZIP, phone, card), not a quantity. */
function looksLikeIdentifier(value: string): boolean {
  return /^0\d+$/.test(value) || /^\d{16,}$/.test(value);
}

function detectDecimalComma(values: string[]): boolean {
  let comma = 0;
  let dot = 0;
  for (const value of values.slice(0, 5000)) {
    const digits = value.replace(/[^0-9.,]/g, "");
    if (/,\d{1,2}$/.test(digits) && !/\.\d+,/.test(digits.replace(/\.\d{3}/g, ""))) comma++;
    else if (/\.\d{1,2}$|\.\d{4,}$/.test(digits)) dot++;
  }
  return comma > 0 && dot === 0;
}

// Dates ----------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

function validDate(y: number, m: number, d: number): boolean {
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const fullYear = (y: string) => (y.length === 2 ? (Number(y) > 69 ? 1900 : 2000) + Number(y) : Number(y));
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

function parseTime(text: string | undefined): string | null | undefined {
  if (!text) return undefined;
  const match = text.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(am|pm)?(?:\s*(?:Z|UTC|[+-]\d{2}(?::?\d{2})?))?$/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const meridiem = match[4]?.toLowerCase();
  if (meridiem === "pm" && hours < 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  if (hours > 23 || Number(match[2]) > 59 || Number(match[3] ?? 0) > 59) return null;
  return `${pad(hours)}:${match[2]}:${match[3] ?? "00"}`;
}

export interface ParsedDate {
  date: string;
  time?: string;
}

/** `dayFirst` only matters for ambiguous numeric forms like 03/04/2024. */
export function parseDate(raw: string, dayFirst = false): ParsedDate | null {
  const text = raw.trim();
  let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ](.+))?$/);
  if (match) {
    const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    return finishDate(y, m, d, match[4]);
  }
  match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?:[T ](.+))?$/);
  if (match) {
    const [a, b] = [Number(match[1]), Number(match[2])];
    const [d, m] = dayFirst ? [a, b] : [b, a];
    return finishDate(fullYear(match[3]), m, d, match[4]);
  }
  match = text.match(/^(\d{1,2})(?:st|nd|rd|th)?[-\s/.]([A-Za-z]{3,9})\.?,?[-\s/.](\d{4}|\d{2})(?:[T ](.+))?$/);
  if (match) {
    const month = MONTHS[match[2].slice(0, 4).toLowerCase()] ?? MONTHS[match[2].slice(0, 3).toLowerCase()];
    return month ? finishDate(fullYear(match[3]), month, Number(match[1]), match[4]) : null;
  }
  match = text.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:[T ,]+(.+))?$/);
  if (match) {
    const month = MONTHS[match[1].slice(0, 4).toLowerCase()] ?? MONTHS[match[1].slice(0, 3).toLowerCase()];
    return month ? finishDate(Number(match[3]), month, Number(match[2]), match[4]) : null;
  }
  match = text.match(/^([A-Za-z]{3,9})\.?[\s-](\d{4})$/);
  if (match) {
    const month = MONTHS[match[1].slice(0, 4).toLowerCase()] ?? MONTHS[match[1].slice(0, 3).toLowerCase()];
    return month ? finishDate(Number(match[2]), month, 1) : null;
  }
  return null;
}

function finishDate(y: number, m: number, d: number, timeText?: string): ParsedDate | null {
  if (!validDate(y, m, d)) return null;
  const time = parseTime(timeText);
  if (time === null) return null;
  return time ? { date: iso(y, m, d), time } : { date: iso(y, m, d) };
}

function detectDayFirst(values: string[]): { dayFirst: boolean; ambiguous: boolean } {
  let dayFirst = 0;
  let monthFirst = 0;
  let numeric = 0;
  for (const value of values) {
    const match = value.match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/);
    if (!match) continue;
    numeric++;
    if (Number(match[1]) > 12) dayFirst++;
    if (Number(match[2]) > 12) monthFirst++;
  }
  return { dayFirst: dayFirst > monthFirst, ambiguous: numeric > 0 && dayFirst === 0 && monthFirst === 0 };
}

// Headers --------------------------------------------------------------------

/** The header is the first row that looks like labels: full width, unique, non-numeric. */
export function detectHeaderRow(rows: string[][]): number {
  const scan = rows.slice(0, 25);
  const filled = scan.map((row) => row.filter((c) => c.trim() !== "").length);
  const width = Math.max(0, ...filled);
  if (width === 0) return 0;
  for (let i = 0; i < scan.length; i++) {
    if (filled[i] < Math.max(2, width * 0.6) && width > 1) continue;
    const cells = scan[i].map((c) => c.trim()).filter(Boolean);
    const numeric = cells.filter((c) => parseNumber(c) !== null || parseDate(c) !== null).length;
    if (numeric / cells.length > 0.5) continue;
    if (new Set(cells.map((c) => c.toLowerCase())).size < cells.length * 0.8) continue;
    return i;
  }
  return 0;
}

// Pipeline -------------------------------------------------------------------

interface TypedColumn {
  type: ColType;
  unit?: string;
  values: (string | null)[];
  failed: number;
  failedExamples: string[];
  ambiguousDates: boolean;
  reformatted: number;
  label?: string;
}

function coerce(
  values: (string | null)[],
  parse: (value: string) => string | null,
  type: ColType,
): TypedColumn | null {
  const out: (string | null)[] = new Array(values.length);
  let ok = 0;
  let failed = 0;
  let reformatted = 0;
  const failedExamples = new Set<string>();
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value === null) {
      out[i] = null;
      continue;
    }
    const parsed = parse(value);
    if (parsed === null) {
      out[i] = null;
      failed++;
      if (failedExamples.size < 5) failedExamples.add(value);
    } else {
      out[i] = parsed;
      ok++;
      if (parsed !== value) reformatted++;
    }
  }
  if (ok === 0 || ok / (ok + failed) < PARSE_THRESHOLD) return null;
  return { type, values: out, failed, failedExamples: [...failedExamples], ambiguousDates: false, reformatted };
}

function inferColumn(values: (string | null)[], name: string): TypedColumn {
  const present = values.filter((v): v is string => v !== null);
  const textColumn: TypedColumn = { type: "text", values, failed: 0, failedExamples: [], ambiguousDates: false, reformatted: 0 };
  if (present.length === 0) return textColumn;

  const lower = present.map((v) => v.toLowerCase());
  const hasBothSides = lower.some((v) => TRUE_TOKENS.has(v)) && lower.some((v) => FALSE_TOKENS.has(v));
  const allWords = lower.every((v) => v.length > 1);
  if (lower.every((v) => TRUE_TOKENS.has(v) || FALSE_TOKENS.has(v)) && (allWords || hasBothSides)) {
    const out = coerce(values, (v) => (TRUE_TOKENS.has(v.toLowerCase()) ? "true" : "false"), "boolean");
    if (out) return out;
  }

  // A column of bare integers is never a date, whatever it looks like.
  const { dayFirst, ambiguous } = detectDayFirst(present);
  let hasTime = false;
  const dates = coerce(
    values,
    (v) => {
      const parsed = parseDate(v, dayFirst);
      if (!parsed) return null;
      if (parsed.time && parsed.time !== "00:00:00") hasTime = true;
      return parsed.time ? `${parsed.date} ${parsed.time}` : parsed.date;
    },
    "date",
  );
  if (dates) {
    dates.type = hasTime ? "datetime" : "date";
    if (!hasTime) dates.values = dates.values.map((v) => (v ? v.slice(0, 10) : v));
    dates.ambiguousDates = ambiguous;
    return dates;
  }

  if (present.some(looksLikeIdentifier) || /(^|_)(id|code|zip|postcode|phone|sku)$/.test(name) && present.some((v) => !/^-?\d+$/.test(v))) {
    return textColumn;
  }

  const decimalComma = detectDecimalComma(present);
  const units = new Map<string, number>();
  let allIntegers = true;
  const numbers = coerce(
    values,
    (v) => {
      const parsed = parseNumber(v, decimalComma);
      if (!parsed) return null;
      if (parsed.unit) units.set(parsed.unit, (units.get(parsed.unit) ?? 0) + 1);
      if (!Number.isSafeInteger(parsed.value)) allIntegers = false;
      return String(parsed.value);
    },
    "number",
  );
  if (numbers) {
    numbers.type = allIntegers ? "integer" : "number";
    const unit = [...units.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (unit) numbers.unit = unit === "US$" ? "USD" : unit;
    return numbers;
  }
  return textColumn;
}

/** Merge spelling variants that differ only by case, spacing or punctuation. */
function mergeVariants(values: (string | null)[]): { values: (string | null)[]; changed: number; merged: string[] } {
  const counts = new Map<string, number>();
  for (const value of values) if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
  const present = values.length - values.filter((v) => v === null).length;
  if (counts.size < 2 || counts.size > Math.max(60, present * 0.2)) return { values, changed: 0, merged: [] };

  const groups = new Map<string, [string, number][]>();
  for (const [value, count] of counts) {
    const key = value.toLowerCase().replace(/[\s._\-,'"]+/g, "");
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push([value, count]);
  }
  const replace = new Map<string, string>();
  const merged: string[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => b[1] - a[1]);
    const canonical = group[0][0];
    for (const [variant] of group.slice(1)) replace.set(variant, canonical);
    merged.push(`${group.map(([v]) => `"${v}"`).join(", ")} → "${canonical}"`);
  }
  if (replace.size === 0) return { values, changed: 0, merged: [] };
  let changed = 0;
  const out = values.map((value) => {
    const next = value === null ? null : replace.get(value);
    if (next === undefined || next === null) return value;
    changed++;
    return next;
  });
  return { values: out, changed, merged };
}

function quality(completeCells: number, totalCells: number, uniqueRows: number, rows: number, consistentCells: number, presentCells: number): QualityScore {
  const completeness = totalCells ? completeCells / totalCells : 1;
  const uniqueness = rows ? uniqueRows / rows : 1;
  const consistency = presentCells ? consistentCells / presentCells : 1;
  return {
    score: Math.floor((completeness * 0.5 + uniqueness * 0.25 + consistency * 0.25) * 100),
    completeness,
    uniqueness,
    consistency,
  };
}

export function cleanTable(input: (string | null | undefined)[][]): CleanResult {
  const actions: CleanAction[] = [];
  const add = (action: Omit<CleanAction, "severity"> & { severity?: CleanAction["severity"] }) =>
    actions.push({ severity: "info", ...action });

  const width = input.reduce((max, row) => Math.max(max, row.length), 0);
  let cellsChanged = 0;
  const table = input.map((row) => {
    const out: string[] = new Array(width);
    for (let i = 0; i < width; i++) {
      const raw = row[i] === null || row[i] === undefined ? "" : String(row[i]);
      out[i] = normalizeCell(raw);
      if (out[i] !== raw) cellsChanged++;
    }
    return out;
  });
  if (cellsChanged > 0) {
    add({ kind: "whitespace", title: "Tidied whitespace", detail: "Removed stray spaces and invisible characters.", count: cellsChanged });
  }

  const headerRow = detectHeaderRow(table);
  if (headerRow > 0) {
    add({
      kind: "header",
      title: `Skipped ${headerRow} ${headerRow === 1 ? "line" : "lines"} above the header`,
      detail: table.slice(0, headerRow).map((r) => r.filter(Boolean).join(" ")).filter(Boolean).join(" · ").slice(0, 200) || "Blank lines",
      count: headerRow,
    });
  }
  const header = table[headerRow] ?? [];
  const headerKey = header.join("\u0001").toLowerCase();
  let body = table.slice(headerRow + 1);
  const rowsBefore = input.length - headerRow - 1;

  const nonEmpty = body.filter((row) => row.some((c) => c !== ""));
  if (nonEmpty.length < body.length) {
    add({ kind: "empty_rows", title: "Removed empty rows", count: body.length - nonEmpty.length });
  }
  body = nonEmpty;

  const noRepeats = body.filter((row) => row.join("\u0001").toLowerCase() !== headerKey);
  if (noRepeats.length < body.length) {
    add({ kind: "repeat_headers", title: "Removed repeated header rows", detail: "Common in merged or paginated exports.", count: body.length - noRepeats.length });
  }
  body = noRepeats;

  // A "Total" row silently doubles every sum, so it goes, and the report says so.
  const isTotal = (row: string[]) => {
    const firstIndex = row.findIndex((c) => c !== "");
    if (firstIndex < 0 || !/^(grand\s*|sub\s*)?totals?:?$/i.test(row[firstIndex])) return false;
    return row.slice(firstIndex + 1).some((c) => parseNumber(c) !== null);
  };
  const totals = body.filter(isTotal);
  if (totals.length > 0) {
    add({ kind: "totals", title: "Removed total rows", detail: "They would double-count every sum.", count: totals.length, examples: totals.slice(0, 2).map((r) => r.filter(Boolean).slice(0, 4).join(" | ")), severity: "warn" });
    body = body.filter((row) => !isTotal(row));
  }

  // Null tokens are counted on the data as it arrived, for an honest "before" score.
  let nullTokens = 0;
  const rawColumns: (string | null)[][] = Array.from({ length: width }, () => new Array(body.length));
  for (let r = 0; r < body.length; r++) {
    for (let c = 0; c < width; c++) {
      const cell = body[r][c];
      if (isNullToken(cell)) {
        if (cell !== "") nullTokens++;
        rawColumns[c][r] = null;
      } else {
        rawColumns[c][r] = cell;
      }
    }
  }
  if (nullTokens > 0) {
    add({ kind: "null_tokens", title: "Converted placeholders to missing values", detail: 'Text such as "N/A", "-" and "null".', count: nullTokens });
  }

  // Dropping empty columns ---------------------------------------------------
  const keep: number[] = [];
  const droppedColumns: string[] = [];
  for (let c = 0; c < width; c++) {
    if (rawColumns[c].some((v) => v !== null)) keep.push(c);
    else droppedColumns.push(header[c] || `column ${c + 1}`);
  }
  if (droppedColumns.length > 0) {
    add({ kind: "empty_columns", title: "Dropped empty columns", count: droppedColumns.length, examples: droppedColumns.slice(0, 5) });
  }

  // Names --------------------------------------------------------------------
  const used = new Map<string, number>();
  const renamed: string[] = [];
  const columns: CleanColumn[] = keep.map((c) => {
    const originalName = header[c] || `Column ${c + 1}`;
    const base = toColumnName(header[c] ?? "", c);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const name = seen === 0 ? base : `${base}_${seen + 1}`;
    if (name !== originalName) renamed.push(`${originalName} → ${name}`);
    return { name, originalName, type: "text", values: rawColumns[c] };
  });
  if (renamed.length > 0) {
    add({ kind: "rename", title: "Standardized column names", detail: "Lowercase with underscores, so they work in SQL.", count: renamed.length, examples: renamed.slice(0, 4) });
  }

  // Types --------------------------------------------------------------------
  let reformattedCells = 0;
  let failedCells = 0;
  for (const column of columns) {
    const typed = inferColumn(column.values, column.name);
    column.type = typed.type;
    column.unit = typed.unit;
    column.values = typed.values;
    reformattedCells += typed.reformatted;
    failedCells += typed.failed;
    if (typed.reformatted > 0) {
      const what = typed.type === "date" || typed.type === "datetime" ? "dates" : typed.type === "boolean" ? "true/false values" : "numbers";
      add({
        kind: "format",
        title: `Standardized ${what} in ${column.name}`,
        detail: typed.unit ? `Stripped the ${typed.unit} symbol and separators.` : undefined,
        column: column.name,
        count: typed.reformatted,
      });
    }
    if (typed.failed > 0) {
      add({
        kind: "unparseable",
        title: `Blanked values that do not fit ${column.name}`,
        detail: `Column is ${typed.type}; these could not be read as ${typed.type}.`,
        column: column.name,
        count: typed.failed,
        examples: typed.failedExamples,
        severity: "warn",
      });
    }
    if (typed.ambiguousDates) {
      add({
        kind: "ambiguous_dates",
        title: `Check the date order in ${column.name}`,
        detail: "Every date could be read as day/month or month/day. Assumed month/day.",
        column: column.name,
        count: typed.values.filter((v) => v !== null).length,
        severity: "warn",
      });
    }
    if (typed.type === "text") {
      const merged = mergeVariants(typed.values);
      if (merged.changed > 0) {
        column.values = merged.values;
        reformattedCells += merged.changed;
        add({ kind: "variants", title: `Merged spelling variants in ${column.name}`, column: column.name, count: merged.changed, examples: merged.merged.slice(0, 4) });
      }
    }
  }

  // Exact duplicates ---------------------------------------------------------
  const seenRows = new Set<string>();
  const keepRows: number[] = [];
  for (let r = 0; r < body.length; r++) {
    const key = columns.map((c) => c.values[r] ?? "\u0000").join("\u0001");
    if (!seenRows.has(key)) {
      seenRows.add(key);
      keepRows.push(r);
    }
  }
  const duplicates = body.length - keepRows.length;
  if (duplicates > 0) {
    add({ kind: "duplicates", title: "Removed exact duplicate rows", count: duplicates });
    for (const column of columns) column.values = keepRows.map((r) => column.values[r]);
  }

  // Scores -------------------------------------------------------------------
  const rowsAfter = keepRows.length;
  const presentBefore = rawColumns.reduce((sum, col) => sum + col.reduce((n, v) => n + (v !== null ? 1 : 0), 0), 0);
  const totalBefore = width * body.length;
  const qualityBefore = quality(presentBefore, totalBefore, rowsAfter, body.length, presentBefore - reformattedCells - failedCells, presentBefore);

  const totalAfter = columns.length * rowsAfter;
  const presentAfter = columns.reduce((sum, col) => sum + col.values.reduce((n, v) => n + (v !== null ? 1 : 0), 0), 0);
  const qualityAfter = quality(presentAfter, totalAfter, rowsAfter, rowsAfter, presentAfter, presentAfter);

  return {
    columns,
    rowCount: rowsAfter,
    report: {
      rowsBefore: Math.max(0, rowsBefore),
      rowsAfter,
      columnsBefore: width,
      columnsAfter: columns.length,
      headerRow,
      cellsChanged: cellsChanged + reformattedCells,
      actions,
      qualityBefore,
      qualityAfter,
    },
  };
}

import { json, route } from "@/lib/api";
import { requestCheck } from "@/lib/alerts/runner";
import { ingestTable } from "@/lib/ingest/ingest";
import { parseFile, type ParsedTable } from "@/lib/ingest/parse";
import { readSqliteFile } from "@/lib/sources/connectors";
import type { Dataset } from "@/lib/types";

const MAX_BYTES = 200 * 1024 * 1024;

export const POST = route(async (request) => {
  const form = await request.formData();
  const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) return json({ error: "No files were sent." }, 400);

  const created: Dataset[] = [];
  const errors: { file: string; message: string }[] = [];
  for (const file of files) {
    try {
      if (file.size > MAX_BYTES) throw new Error("This file is over the 200 MB limit.");
      const buffer = Buffer.from(await file.arrayBuffer());
      const isSqlite = /\.(sqlite3?|db)$/i.test(file.name);
      const tables: ParsedTable[] = isSqlite ? await readSqliteFile(file.name, buffer) : parseFile(file.name, buffer);
      if (tables.length === 0) throw new Error("No data found in this file.");
      for (const table of tables) {
        try {
          created.push(await ingestTable(table, { kind: isSqlite ? "sqlite" : "file", name: file.name }));
        } catch (error) {
          errors.push({ file: table.sheet ? `${file.name} (${table.sheet})` : file.name, message: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      errors.push({ file: file.name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const dataset of created) requestCheck(dataset.id);
  return json({ datasets: created, errors });
});

import { z } from "zod";
import { json, route } from "@/lib/api";
import { requestCheck } from "@/lib/alerts/runner";
import { ingestTable } from "@/lib/ingest/ingest";
import { fetchUrlTables } from "@/lib/sources/connectors";
import type { Dataset } from "@/lib/types";

export const POST = route(async (request) => {
  const { url } = z.object({ url: z.string() }).parse(await request.json());
  const created: Dataset[] = [];
  const errors: { file: string; message: string }[] = [];
  for (const table of await fetchUrlTables(url)) {
    try {
      created.push(await ingestTable(table, { kind: "url", name: new URL(url).hostname }));
    } catch (error) {
      errors.push({ file: table.sheet ?? table.name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const dataset of created) requestCheck(dataset.id);
  return json({ datasets: created, errors });
});

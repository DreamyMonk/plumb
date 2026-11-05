import fs from "node:fs/promises";
import path from "node:path";
import { json, route } from "@/lib/api";
import { ingestTable } from "@/lib/ingest/ingest";
import { parseFile } from "@/lib/ingest/parse";
import type { Dataset } from "@/lib/types";

const SAMPLES = ["retail_orders.csv", "customers.csv"];

export const POST = route(async () => {
  const created: Dataset[] = [];
  for (const name of SAMPLES) {
    const buffer = await fs.readFile(path.join(process.cwd(), "public", "samples", name));
    for (const table of parseFile(name, buffer)) {
      created.push(await ingestTable(table, { kind: "sample", name }));
    }
  }
  return json({ datasets: created, errors: [] });
});

import fs from "node:fs/promises";
import path from "node:path";
import { json, route } from "@/lib/api";
import { ingestTable } from "@/lib/ingest/ingest";
import { parseFile } from "@/lib/ingest/parse";
import { events, newId } from "@/lib/store";
import type { Dataset, EventNote } from "@/lib/types";

const SAMPLES = ["retail_orders.csv", "customers.csv"];

// Two of the three incidents planted in the sample are logged. The July one is left for
// the Timeline to find, and the free shipping launch had no real effect.
const SAMPLE_EVENTS: Pick<EventNote, "date" | "title" | "detail" | "category">[] = [
  { date: "2025-11-28", title: "Black Friday campaign", detail: "25% off electronics online", category: "promotion" },
  { date: "2026-03-12", title: "Checkout outage", detail: "Online orders failed all day", category: "incident" },
  { date: "2026-05-04", title: "Free shipping launched", category: "release" },
];

export const POST = route(async () => {
  const created: Dataset[] = [];
  for (const name of SAMPLES) {
    const buffer = await fs.readFile(path.join(process.cwd(), "public", "samples", name));
    for (const table of parseFile(name, buffer)) {
      created.push(await ingestTable(table, { kind: "sample", name }));
    }
  }
  const table = created.find((d) => d.label === "retail_orders")?.id ?? "retail_orders";
  const existing = await events.list();
  for (const event of SAMPLE_EVENTS) {
    if (existing.some((e) => e.date === event.date && e.title === event.title)) continue;
    await events.save({ ...event, id: newId(), table, source: "sample", createdAt: new Date().toISOString() });
  }
  return json({ datasets: created, errors: [] });
});

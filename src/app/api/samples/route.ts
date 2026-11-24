import fs from "node:fs/promises";
import path from "node:path";
import { json, route } from "@/lib/api";
import { requestCheck } from "@/lib/alerts/runner";
import { ingestTable } from "@/lib/ingest/ingest";
import { parseFile } from "@/lib/ingest/parse";
import { events, metrics, newId } from "@/lib/store";
import type { Dataset, EventNote, Metric } from "@/lib/types";

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
  const customers = created.find((d) => d.label === "customers")?.id ?? "customers";
  const sampleMetrics: Pick<Metric, "name" | "description" | "table" | "expression" | "format" | "currency">[] = [
    { name: "Net revenue", description: "Revenue from orders that weren't returned", table, expression: "SUM(revenue) FILTER (WHERE NOT returned)", format: "currency", currency: "$" },
    { name: "Churn rate", description: "Share of customers who left", table: customers, expression: "AVG(CASE WHEN churned THEN 100.0 ELSE 0 END)", format: "percent" },
  ];
  const existingMetrics = await metrics.list();
  for (const metric of sampleMetrics) {
    if (existingMetrics.some((m) => m.name === metric.name)) continue;
    const now = new Date().toISOString();
    await metrics.save({ ...metric, id: newId(), source: "sample", createdAt: now, updatedAt: now });
  }
  for (const dataset of created) requestCheck(dataset.id);
  return json({ datasets: created, errors: [] });
});

import { z } from "zod";
import { json, route } from "@/lib/api";
import { requestCheck } from "@/lib/alerts/runner";
import { evaluateMetric } from "@/lib/metrics";
import { datasets, metrics, newId } from "@/lib/store";
import type { Metric } from "@/lib/types";

export const metricBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  table: z.string(),
  expression: z.string().trim().min(1).max(2000),
  format: z.enum(["number", "currency", "percent"]).optional(),
  currency: z.string().max(4).optional(),
});

/** Each metric comes back with its current value, or the reason it can't be calculated. */
export const GET = route(async () => {
  const list = await metrics.list();
  list.sort((a, b) => a.name.localeCompare(b.name));
  const withValues = await Promise.all(
    list.map(async (metric) => {
      try {
        return { ...metric, value: await evaluateMetric(metric.table, metric.expression) };
      } catch (error) {
        return { ...metric, value: null, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  return json(withValues);
});

export const POST = route(async (request) => {
  const input = metricBody.parse(await request.json());
  if (!(await datasets.get(input.table))) return json({ error: "Choose an existing table." }, 400);
  if ((await metrics.list()).some((m) => m.name.toLowerCase() === input.name.toLowerCase())) return json({ error: `A metric called "${input.name}" already exists.` }, 400);
  const value = await evaluateMetric(input.table, input.expression); // refuses anything that isn't one number
  const now = new Date().toISOString();
  const metric: Metric = { ...input, id: newId(), source: "user", createdAt: now, updatedAt: now };
  await metrics.save(metric);
  requestCheck(input.table);
  return json({ ...metric, value });
});

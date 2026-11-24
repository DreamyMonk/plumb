import { json, route } from "@/lib/api";
import { evaluateMetric } from "@/lib/metrics";
import { metrics } from "@/lib/store";
import { metricBody } from "../route";

type Context = { params: Promise<{ id: string }> };

export const PATCH = route<Context>(async (request, { params }) => {
  const { id } = await params;
  const metric = await metrics.get(id);
  if (!metric) return json({ error: "Metric not found." }, 404);
  const input = metricBody.parse(await request.json());
  const value = await evaluateMetric(input.table, input.expression);
  const next = { ...metric, ...input, updatedAt: new Date().toISOString() };
  await metrics.save(next);
  return json({ ...next, value });
});

export const DELETE = route<Context>(async (_request, { params }) => {
  const { id } = await params;
  await metrics.remove(id);
  return json({ ok: true });
});

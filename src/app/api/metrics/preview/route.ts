import { z } from "zod";
import { json, route } from "@/lib/api";
import { evaluateMetric } from "@/lib/metrics";

export const POST = route(async (request) => {
  const { table, expression } = z.object({ table: z.string(), expression: z.string().max(2000) }).parse(await request.json());
  return json({ value: await evaluateMetric(table, expression) });
});

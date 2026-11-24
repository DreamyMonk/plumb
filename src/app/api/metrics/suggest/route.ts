import { z } from "zod";
import { suggestMetrics } from "@/lib/ai/metrics";
import { json, route } from "@/lib/api";
import { datasets } from "@/lib/store";

export const POST = route(async (request) => {
  const { table } = z.object({ table: z.string() }).parse(await request.json());
  const dataset = await datasets.get(table);
  if (!dataset) return json({ error: "Table not found." }, 404);
  return json(await suggestMetrics(dataset, request.signal));
});

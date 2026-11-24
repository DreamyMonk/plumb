import { z } from "zod";
import { json, route } from "@/lib/api";
import { measureImpact } from "@/lib/timeline";

const body = z.object({
  table: z.string(),
  dateColumn: z.string(),
  valueColumn: z.string().nullish(),
  agg: z.enum(["sum", "avg", "count"]),
  metric: z.string().nullish(),
  grain: z.enum(["day", "week", "month", "quarter", "year"]).nullish(),
  eventId: z.string().nullish(),
  date: z.string().nullish(),
  window: z.number().int().positive().nullish(),
});

export const POST = route(async (request) => json(await measureImpact(body.parse(await request.json()))));

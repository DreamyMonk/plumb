import { z } from "zod";
import { json, route } from "@/lib/api";
import { buildTimeline } from "@/lib/timeline";

const body = z.object({
  table: z.string(),
  dateColumn: z.string(),
  valueColumn: z.string().nullish(),
  agg: z.enum(["sum", "avg", "count"]),
  grain: z.enum(["day", "week", "month", "quarter", "year"]).nullish(),
});

export const POST = route(async (request) => json(await buildTimeline(body.parse(await request.json()))));

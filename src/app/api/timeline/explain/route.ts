import { z } from "zod";
import { json, route } from "@/lib/api";
import { explainPeriod } from "@/lib/timeline";

const body = z.object({
  table: z.string(),
  dateColumn: z.string(),
  valueColumn: z.string().nullish(),
  agg: z.enum(["sum", "avg", "count"]),
  metric: z.string().nullish(),
  grain: z.enum(["day", "week", "month", "quarter", "year"]).nullish(),
  date: z.string(),
});

export const POST = route(async (request) => json(await explainPeriod(body.parse(await request.json()))));

import { z } from "zod";
import { forecastTable } from "@/lib/analytics";
import { json, route } from "@/lib/api";

const body = z.object({
  table: z.string(),
  dateColumn: z.string(),
  valueColumn: z.string().nullish(),
  agg: z.enum(["sum", "avg", "count"]),
  grain: z.enum(["day", "week", "month", "quarter", "year"]).nullish(),
  horizon: z.number().int().positive().nullish(),
});

export const POST = route(async (request) => json(await forecastTable(body.parse(await request.json()))));

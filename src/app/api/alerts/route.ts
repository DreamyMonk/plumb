import { z } from "zod";
import { json, route } from "@/lib/api";
import { checkAlert } from "@/lib/alerts/runner";
import { alerts, newId } from "@/lib/store";
import type { AlertRule } from "@/lib/types";

export const alertBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    kind: z.enum(["threshold", "change", "anomaly", "stale", "incident"]),
    metricId: z.string().nullish(),
    table: z.string().nullish(),
    dateColumn: z.string().nullish(),
    grain: z.enum(["day", "week", "month", "quarter", "year"]).nullish(),
    op: z.enum(["above", "below"]).optional(),
    value: z.number().finite().nullish(),
    changePct: z.number().positive().max(10000).nullish(),
    direction: z.enum(["drop", "rise", "any"]).optional(),
    staleMinutes: z.number().int().min(1).max(60 * 24 * 30).nullish(),
    notifyResolved: z.boolean().default(true),
  })
  .superRefine((input, ctx) => {
    const need = (ok: unknown, message: string) => {
      if (!ok) ctx.addIssue({ code: "custom", message });
    };
    if (["threshold", "change", "anomaly"].includes(input.kind)) {
      need(input.metricId || input.table, "Choose a metric or a table.");
      need(input.dateColumn, "Choose a date column.");
    }
    if (input.kind === "threshold") need(input.value !== null && input.value !== undefined && input.op, "Set a limit.");
    if (input.kind === "change") need(input.changePct, "Set a percentage.");
    if (input.kind === "stale") need(input.table && input.staleMinutes, "Choose a table and a number of minutes.");
  });

export const GET = route(async () => {
  const list = await alerts.list();
  list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return json(list);
});

export const POST = route(async (request) => {
  const parsed = alertBody.safeParse(await request.json());
  if (!parsed.success) return json({ error: parsed.error.issues.map((i) => i.message).join(" ") }, 400);
  const rule: AlertRule = { ...parsed.data, id: newId(), enabled: true, status: "pending", createdAt: new Date().toISOString() };
  await alerts.save(rule);
  return json((await checkAlert(rule.id)) ?? rule);
});

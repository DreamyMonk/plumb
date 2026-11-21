import { z } from "zod";
import { json, route } from "@/lib/api";
import { dashboards, newId } from "@/lib/store";
import type { ChartSpec, Row } from "@/lib/types";

type Context = { params: Promise<{ id: string }> };

const body = z.object({
  spec: z.looseObject({ type: z.string(), title: z.string() }),
  rows: z.array(z.record(z.string(), z.unknown())).optional(),
});

export const POST = route<Context>(async (request, { params }) => {
  const { id } = await params;
  const dashboard = await dashboards.get(id);
  if (!dashboard) return json({ error: "Dashboard not found." }, 404);
  const input = body.parse(await request.json());
  const spec = input.spec as unknown as ChartSpec;
  dashboard.widgets.push({
    id: newId(),
    spec,
    size: spec.type === "kpi" ? "s" : "m",
    rows: spec.sql || spec.timeline ? undefined : (input.rows as Row[]),
  });
  dashboard.updatedAt = new Date().toISOString();
  await dashboards.save(dashboard);
  return json(dashboard);
});

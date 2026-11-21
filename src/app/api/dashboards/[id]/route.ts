import { z } from "zod";
import { json, route } from "@/lib/api";
import { buildChartSafe } from "@/lib/charts";
import { dashboards } from "@/lib/store";
import type { ChartPayload } from "@/lib/types";

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>(async (_request, { params }) => {
  const { id } = await params;
  const dashboard = await dashboards.get(id);
  if (!dashboard) return json({ error: "Dashboard not found." }, 404);
  // Charts re-run on every load, so a dashboard always reflects the current data.
  const payloads: ChartPayload[] = await Promise.all(
    dashboard.widgets.map((widget) =>
      widget.spec.sql || widget.spec.timeline ? buildChartSafe(widget.spec) : Promise.resolve({ spec: widget.spec, columns: [], rows: widget.rows ?? [] }),
    ),
  );
  return json({ dashboard, payloads });
});

const patch = z.object({
  title: z.string().min(1).optional(),
  widgetOrder: z.array(z.string()).optional(),
  sizes: z.record(z.string(), z.enum(["s", "m", "l"])).optional(),
});

export const PATCH = route<Context>(async (request, { params }) => {
  const { id } = await params;
  const dashboard = await dashboards.get(id);
  if (!dashboard) return json({ error: "Dashboard not found." }, 404);
  const input = patch.parse(await request.json());
  if (input.title) dashboard.title = input.title;
  if (input.widgetOrder) {
    // Anything missing from the list is removed; unknown ids are ignored.
    dashboard.widgets = input.widgetOrder.flatMap((widgetId) => dashboard.widgets.filter((w) => w.id === widgetId));
  }
  if (input.sizes) {
    for (const widget of dashboard.widgets) widget.size = input.sizes[widget.id] ?? widget.size;
  }
  dashboard.updatedAt = new Date().toISOString();
  await dashboards.save(dashboard);
  return json(dashboard);
});

export const DELETE = route<Context>(async (_request, { params }) => {
  const { id } = await params;
  await dashboards.remove(id);
  return json({ ok: true });
});

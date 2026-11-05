import { z } from "zod";
import { json, route } from "@/lib/api";
import { dashboards, newId } from "@/lib/store";

export const GET = route(async () => {
  const list = await dashboards.list();
  list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return json(list);
});

export const POST = route(async (request) => {
  const { title } = z.object({ title: z.string().min(1) }).parse(await request.json());
  const now = new Date().toISOString();
  const dashboard = { id: newId(), title, tables: [], widgets: [], createdAt: now, updatedAt: now };
  await dashboards.save(dashboard);
  return json(dashboard);
});

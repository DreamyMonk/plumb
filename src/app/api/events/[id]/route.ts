import { json, route } from "@/lib/api";
import { events } from "@/lib/store";

type Context = { params: Promise<{ id: string }> };

export const DELETE = route<Context>(async (_request, { params }) => {
  const { id } = await params;
  await events.remove(id);
  return json({ ok: true });
});

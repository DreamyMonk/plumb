import { z } from "zod";
import { json, route } from "@/lib/api";
import { checkAlert } from "@/lib/alerts/runner";
import { alerts } from "@/lib/store";

type Context = { params: Promise<{ id: string }> };

export const PATCH = route<Context>(async (request, { params }) => {
  const { id } = await params;
  const { action } = z.object({ action: z.enum(["pause", "resume", "check"]) }).parse(await request.json());
  const rule = await alerts.get(id);
  if (!rule) return json({ error: "Alert not found." }, 404);
  if (action === "pause") {
    await alerts.save({ ...rule, enabled: false });
    return json({ ...rule, enabled: false });
  }
  if (action === "resume") await alerts.save({ ...rule, enabled: true });
  return json(await checkAlert(id));
});

export const DELETE = route<Context>(async (_request, { params }) => {
  const { id } = await params;
  await alerts.remove(id);
  return json({ ok: true });
});

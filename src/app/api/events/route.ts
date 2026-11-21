import { z } from "zod";
import { json, route } from "@/lib/api";
import { events, newId } from "@/lib/store";
import type { EventNote } from "@/lib/types";

const body = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: z.string().trim().min(1).max(200),
  detail: z.string().max(1000).optional(),
  category: z.enum(["promotion", "incident", "release", "holiday", "pipeline", "other"]),
  table: z.string().nullish(),
});

export const GET = route(async () => {
  const list = await events.list();
  list.sort((a, b) => b.date.localeCompare(a.date));
  return json(list);
});

export const POST = route(async (request) => {
  const input = body.parse(await request.json());
  const event: EventNote = { id: newId(), ...input, source: "user", createdAt: new Date().toISOString() };
  await events.save(event);
  return json(event);
});

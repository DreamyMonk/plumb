import { z } from "zod";
import { json, route } from "@/lib/api";
import { addLink, getLinks } from "@/lib/links";

export const GET = route(async () => json(await getLinks()));

export const POST = route(async (request) => {
  const input = z.object({ fromTable: z.string(), fromColumn: z.string(), toTable: z.string(), toColumn: z.string() }).parse(await request.json());
  if (input.fromTable === input.toTable) return json({ error: "Choose two different tables." }, 400);
  return json(await addLink(input));
});

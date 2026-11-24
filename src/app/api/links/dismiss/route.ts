import { z } from "zod";
import { json, route } from "@/lib/api";
import { dismissLink } from "@/lib/links";

export const POST = route(async (request) => {
  const { id } = z.object({ id: z.string() }).parse(await request.json());
  await dismissLink(id);
  return json({ ok: true });
});

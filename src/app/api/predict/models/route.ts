import { json, route } from "@/lib/api";
import { models } from "@/lib/store";

export const GET = route(async () => {
  const list = await models.list();
  return json(list.map((m) => m.summary).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

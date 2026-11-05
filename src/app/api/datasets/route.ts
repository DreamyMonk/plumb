import { json, route } from "@/lib/api";
import { datasets } from "@/lib/store";

export const GET = route(async () => {
  const list = await datasets.list();
  list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return json(list);
});

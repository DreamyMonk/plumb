import { json, route } from "@/lib/api";
import { alertHistory } from "@/lib/store";

const SHOWN = 100;

export const GET = route(async () => {
  const list = await alertHistory.list();
  list.sort((a, b) => b.at.localeCompare(a.at));
  return json(list.slice(0, SHOWN));
});

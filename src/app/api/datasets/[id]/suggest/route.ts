import { aiSuggestions } from "@/lib/ai/suggest";
import { json, route } from "@/lib/api";
import { datasets } from "@/lib/store";

type Context = { params: Promise<{ id: string }> };

export const POST = route<Context>(async (request, { params }) => {
  const { id } = await params;
  const dataset = await datasets.get(id);
  if (!dataset) return json({ error: "Dataset not found." }, 404);
  return json(await aiSuggestions(dataset, request.signal));
});

import { json, route } from "@/lib/api";
import { removeDataset } from "@/lib/ingest/ingest";
import { datasets } from "@/lib/store";

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>(async (_request, { params }) => {
  const { id } = await params;
  const dataset = await datasets.get(id);
  return dataset ? json(dataset) : json({ error: "Dataset not found." }, 404);
});

export const DELETE = route<Context>(async (_request, { params }) => {
  const { id } = await params;
  if (!(await datasets.get(id))) return json({ error: "Dataset not found." }, 404);
  await removeDataset(id);
  return json({ ok: true });
});

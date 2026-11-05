import { z } from "zod";
import { scoreModel } from "@/lib/analytics";
import { json, route } from "@/lib/api";
import { models } from "@/lib/store";

type Context = { params: Promise<{ id: string }> };

const body = z.object({ inputs: z.array(z.record(z.string(), z.unknown())).min(1).max(1000) });

export const POST = route<Context>(async (request, { params }) => {
  const { id } = await params;
  const { inputs } = body.parse(await request.json());
  const { results } = await scoreModel(id, inputs);
  return json({ results });
});

export const DELETE = route<Context>(async (_request, { params }) => {
  const { id } = await params;
  await models.remove(id);
  return json({ ok: true });
});

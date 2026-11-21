import { z } from "zod";
import { json, route } from "@/lib/api";
import { datasets } from "@/lib/store";
import { withTableLock } from "@/lib/streams/lock";

type Context = { params: Promise<{ id: string }> };

const body = z.object({ column: z.string(), mode: z.enum(["mask", "allow", "auto"]) });

/** The user's choice for one column: always mask, never mask, or follow detection. */
export const POST = route<Context>(async (request, { params }) => {
  const { id } = await params;
  const { column, mode } = body.parse(await request.json());
  const next = await withTableLock(`table:${id}`, async () => {
    const dataset = await datasets.get(id);
    if (!dataset || !dataset.columns.some((c) => c.name === column)) return null;
    const privacy = { ...dataset.privacy };
    if (mode === "auto") delete privacy[column];
    else privacy[column] = mode;
    const updated = { ...dataset, privacy };
    await datasets.save(updated);
    return updated;
  });
  return next ? json(next) : json({ error: "Column not found." }, 404);
});

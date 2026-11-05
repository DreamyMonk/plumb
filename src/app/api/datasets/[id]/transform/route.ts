import { z } from "zod";
import { json, route } from "@/lib/api";
import { applyTransform, undoTransform } from "@/lib/ingest/ingest";
import { datasets } from "@/lib/store";
import type { TransformOp } from "@/lib/types";

type Context = { params: Promise<{ id: string }> };

const op = z.discriminatedUnion("op", [
  z.object({ op: z.literal("fill_missing"), column: z.string(), strategy: z.enum(["median", "mean", "mode", "constant", "forward_fill"]), value: z.string().optional() }),
  z.object({ op: z.literal("map_values"), column: z.string(), mapping: z.array(z.object({ from: z.string(), to: z.string() })) }),
  z.object({ op: z.literal("drop_column"), column: z.string() }),
  z.object({ op: z.literal("rename_column"), column: z.string(), newName: z.string().min(1) }),
  z.object({ op: z.literal("cast_type"), column: z.string(), to: z.enum(["number", "date", "text", "boolean"]) }),
  z.object({ op: z.literal("drop_rows"), column: z.string(), condition: z.enum(["is_null", "outlier"]) }),
]);

const body = z.union([z.object({ transform: op }), z.object({ undo: z.literal(true) })]);

export const POST = route<Context>(async (request, { params }) => {
  const { id } = await params;
  const dataset = await datasets.get(id);
  if (!dataset) return json({ error: "Dataset not found." }, 404);
  const input = body.parse(await request.json());
  const next = "undo" in input ? await undoTransform(dataset) : await applyTransform(dataset, input.transform as TransformOp);
  return json(next);
});

import { z } from "zod";
import { trainTable } from "@/lib/analytics";
import { json, route } from "@/lib/api";

const body = z.object({ table: z.string(), target: z.string(), features: z.array(z.string()).nullish() });

export const POST = route(async (request) => json(await trainTable(body.parse(await request.json()))));

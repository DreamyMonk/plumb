import { z } from "zod";
import { aiErrorMessage } from "@/lib/ai/client";
import { generateDashboard } from "@/lib/ai/dashboard";
import { json, ndjson } from "@/lib/api";

const body = z.object({
  tables: z.array(z.string()).min(1),
  instruction: z.string().max(2000).nullish(),
  replaceId: z.string().nullish(),
});

type Event = { type: "status"; message: string } | { type: "done"; id: string } | { type: "error"; message: string };

export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Choose at least one dataset." }, 400);
  return ndjson<Event>(request, async (emit, signal) => {
    try {
      const dashboard = await generateDashboard(parsed.data, (message) => emit({ type: "status", message }), signal);
      emit({ type: "done", id: dashboard.id });
    } catch (error) {
      if (!signal.aborted) emit({ type: "error", message: aiErrorMessage(error) });
    }
  });
}

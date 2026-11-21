import { z } from "zod";
import { json, route } from "@/lib/api";
import { streams, type StoredStream } from "@/lib/store";
import { startKafka, stopKafka } from "@/lib/streams/kafka";
import type { StreamInfo } from "@/lib/types";

type Context = { params: Promise<{ id: string }> };

const hide = ({ tokenHash: _hidden, ...info }: StoredStream): StreamInfo => info;

export const PATCH = route<Context>(async (request, { params }) => {
  const { id } = await params;
  const { action } = z.object({ action: z.enum(["pause", "resume"]) }).parse(await request.json());
  const stream = await streams.get(id);
  if (!stream) return json({ error: "Stream not found." }, 404);

  if (action === "pause") {
    if (stream.kind === "kafka") await stopKafka(id);
    const next: StoredStream = { ...stream, status: "paused" };
    await streams.save(next);
    return json(hide(next));
  }
  try {
    if (stream.kind === "kafka") await startKafka(stream);
    const next: StoredStream = { ...stream, status: "active", lastError: undefined };
    await streams.save(next);
    return json(hide(next));
  } catch (error) {
    const next: StoredStream = { ...stream, status: "error", lastError: error instanceof Error ? error.message : String(error) };
    await streams.save(next);
    return json(hide(next));
  }
});

// Deleting a stream keeps the table it filled.
export const DELETE = route<Context>(async (_request, { params }) => {
  const { id } = await params;
  await stopKafka(id);
  await streams.remove(id);
  return json({ ok: true });
});

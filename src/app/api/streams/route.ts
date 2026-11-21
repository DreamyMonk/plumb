import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { json, route } from "@/lib/api";
import { newId, streams, type StoredStream } from "@/lib/store";
import { startKafka } from "@/lib/streams/kafka";
import type { StreamInfo } from "@/lib/types";

const body = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["http", "kafka"]),
  target: z.enum(["table", "events"]),
  dedupeKey: z.string().trim().min(1).nullish(),
  eventTable: z.string().nullish(),
  kafka: z
    .object({
      brokers: z.array(z.string().trim().min(1)).min(1),
      topic: z.string().trim().min(1),
      fromBeginning: z.boolean(),
      ssl: z.boolean(),
      saslMechanism: z.enum(["plain", "scram-sha-256", "scram-sha-512"]).optional(),
    })
    .optional(),
});

export const hide = ({ tokenHash: _hidden, ...info }: StoredStream): StreamInfo => info;

export const GET = route(async () => {
  const list = await streams.list();
  list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return json(list.map(hide));
});

export const POST = route(async (request) => {
  const input = body.parse(await request.json());
  if (input.kind === "kafka" && !input.kafka) return json({ error: "Add your brokers and topic." }, 400);

  // The token is shown once. Only its hash is stored.
  const token = `plumb_${randomBytes(24).toString("base64url")}`;
  const stream: StoredStream = {
    id: newId(),
    name: input.name,
    kind: input.kind,
    target: input.target,
    dedupeKey: input.dedupeKey ?? null,
    eventTable: input.eventTable ?? null,
    table: null,
    status: "active",
    createdAt: new Date().toISOString(),
    rowsReceived: 0,
    rowsDuplicate: 0,
    rowsRejected: 0,
    cellsRejected: 0,
    kafka: input.kafka,
    tokenHash: createHash("sha256").update(token).digest("hex"),
  };
  await streams.save(stream);

  if (stream.kind === "kafka") {
    try {
      await startKafka(stream);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await streams.save({ ...stream, status: "error", lastError: message });
      return json({ stream: hide({ ...stream, status: "error", lastError: message }) });
    }
    return json({ stream: hide(stream) });
  }
  return json({ stream: hide(stream), token });
});

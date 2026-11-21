import "server-only";
import { Kafka, logLevel, type Consumer, type SASLOptions } from "kafkajs";
import { streams, type StoredStream } from "../store";
import { ingestRecords } from "./append";
import { publishUpdate } from "./bus";
import { processBatch } from "./kafka-batch";

const globalForKafka = globalThis as unknown as { __plumbConsumers?: Map<string, Consumer> };
const consumers = (globalForKafka.__plumbConsumers ??= new Map());

function saslOptions(stream: StoredStream): SASLOptions | undefined {
  const mechanism = stream.kafka?.saslMechanism;
  if (!mechanism) return undefined;
  // Secrets come from the environment, so nothing sensitive lands in .data.
  const username = process.env.KAFKA_SASL_USERNAME;
  const password = process.env.KAFKA_SASL_PASSWORD;
  if (!username || !password) throw new Error("Set KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD in .env.local, then restart.");
  return { mechanism, username, password } as SASLOptions;
}

async function setError(id: string, message: string): Promise<void> {
  const stream = await streams.get(id);
  if (!stream) return;
  await streams.save({ ...stream, status: "error", lastError: message });
  publishUpdate({ stream: id, table: stream.table ?? null, target: stream.target, rows: 0 });
}

export async function startKafka(stream: StoredStream): Promise<void> {
  if (!stream.kafka || consumers.has(stream.id)) return;
  const kafka = new Kafka({
    clientId: "plumb",
    brokers: stream.kafka.brokers,
    ssl: stream.kafka.ssl,
    sasl: saslOptions(stream),
    logLevel: logLevel.NOTHING,
    connectionTimeout: 10_000,
  });
  const consumer = kafka.consumer({ groupId: `plumb-${stream.id}` });
  consumer.on(consumer.events.CRASH, (event) => {
    if (!event.payload.restart) {
      consumers.delete(stream.id);
      void setError(stream.id, event.payload.error.message);
    }
  });
  await consumer.connect();
  await consumer.subscribe({ topic: stream.kafka.topic, fromBeginning: stream.kafka.fromBeginning });
  await consumer.run({
    eachBatchAutoResolve: false,
    eachBatch: async (payload) => {
      await processBatch(payload, async (records, undecodable) => {
        await ingestRecords(stream.id, records, undecodable);
      });
    },
  });
  consumers.set(stream.id, consumer);
}

export async function stopKafka(id: string): Promise<void> {
  const consumer = consumers.get(id);
  if (!consumer) return;
  consumers.delete(id);
  await consumer.disconnect();
}

/** Reconnects Kafka streams when the server starts. */
export async function resumeStreams(): Promise<void> {
  for (const stream of await streams.list()) {
    if (stream.kind !== "kafka" || stream.status !== "active") continue;
    try {
      await startKafka(stream);
    } catch (error) {
      await setError(stream.id, error instanceof Error ? error.message : String(error));
    }
  }
}

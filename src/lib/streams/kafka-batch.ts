import { normalizeEpochs, parsePayload, type StreamRecord } from "./payload";

interface BatchMessage {
  offset: string;
  value: Buffer | null;
}

export interface BatchPayload {
  batch: { messages: BatchMessage[] };
  resolveOffset: (offset: string) => void;
  heartbeat: () => Promise<void>;
  commitOffsetsIfNecessary: () => Promise<void>;
  isRunning: () => boolean;
  isStale: () => boolean;
}

export interface BatchOutcome {
  received: number;
  undecodable: number;
}

/**
 * Handles one Kafka batch with at-least-once delivery. Offsets move only after `write` has
 * finished, so a crash mid-write redelivers the messages instead of losing them. A stream's
 * dedupe key removes the resulting repeats. A message that can never be decoded is counted
 * and skipped, so that one bad message can't block the partition forever.
 */
export async function processBatch(payload: BatchPayload, write: (records: StreamRecord[], undecodable: number) => Promise<void>): Promise<BatchOutcome> {
  const { batch, resolveOffset, heartbeat, commitOffsetsIfNecessary, isRunning, isStale } = payload;
  const records: StreamRecord[] = [];
  const offsets: string[] = [];
  let undecodable = 0;

  for (const message of batch.messages) {
    if (!isRunning() || isStale()) break;
    offsets.push(message.offset);
    if (message.value === null) continue; // a tombstone, which carries no row
    try {
      const decoded = parsePayload("application/json", message.value.toString("utf8"));
      if (decoded.length === 0) undecodable++;
      records.push(...decoded.map(normalizeEpochs));
    } catch {
      undecodable++;
    }
  }
  if (offsets.length === 0) return { received: 0, undecodable: 0 };

  await write(records, undecodable); // a failure here throws, so no offset below moves
  for (const offset of offsets) resolveOffset(offset);
  await commitOffsetsIfNecessary();
  await heartbeat();
  return { received: records.length, undecodable };
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processBatch, type BatchPayload } from "../src/lib/streams/kafka-batch";
import { normalizeEpochs, parsePayload, toEvent } from "../src/lib/streams/payload";

describe("parsePayload", () => {
  it("reads one object, an array, wrappers and NDJSON", () => {
    expect(parsePayload("application/json", '{"a":1}')).toEqual([{ a: 1 }]);
    expect(parsePayload("application/json", '[{"a":1},{"a":2}]')).toHaveLength(2);
    expect(parsePayload("application/json", '{"records":[{"a":1}]}')).toEqual([{ a: 1 }]);
    expect(parsePayload("application/x-ndjson", '{"a":1}\n{"a":2}\n')).toHaveLength(2);
  });

  it("does not mistake a list inside one record for many records", () => {
    expect(parsePayload("application/json", '{"id":1,"tags":["x","y"]}')).toEqual([{ id: 1, tags: ["x", "y"] }]);
  });

  it("unwraps Kafka style key and value envelopes", () => {
    expect(parsePayload("application/json", '{"records":[{"key":"k","value":{"a":1}}]}')).toEqual([{ a: 1 }]);
  });

  it("keeps a record that has its own value field", () => {
    expect(parsePayload("application/json", '{"sensor":"s1","value":{"t":20}}')).toEqual([{ sensor: "s1", value: { t: 20 } }]);
  });

  it("reads CSV", () => {
    expect(parsePayload("text/csv", "a,b\n1,2\n")).toEqual([{ a: "1", b: "2" }]);
  });

  it("rejects garbage", () => {
    expect(() => parsePayload("application/json", "not json at all")).toThrow(/not valid/);
  });
});

describe("normalizeEpochs", () => {
  it("converts epoch seconds and milliseconds in time fields", () => {
    expect(normalizeEpochs({ ts: 1762300800 }).ts).toBe("2025-11-05T00:00:00.000Z");
    expect(normalizeEpochs({ created_at: 1762300800000 }).created_at).toBe("2025-11-05T00:00:00.000Z");
  });

  it("leaves other numbers alone", () => {
    expect(normalizeEpochs({ amount: 1762300800 }).amount).toBe(1762300800);
    expect(normalizeEpochs({ ts: 42 }).ts).toBe(42);
  });
});

describe("toEvent", () => {
  it("reads a generic event", () => {
    const event = toEvent({ date: "2026-03-12", title: "Outage", detail: "EU", category: "incident" });
    expect(event).toEqual({ date: "2026-03-12", title: "Outage", detail: "EU", category: "incident" });
  });

  it("reads a dbt Cloud webhook and treats errors as incidents", () => {
    const event = toEvent({
      eventType: "job.run.errored",
      timestamp: "2026-03-12T01:02:03.742843678Z",
      data: { jobName: "Nightly build", runStatus: "Errored", runStatusMessage: "Model orders failed" },
    });
    expect(event).toMatchObject({ date: "2026-03-12", title: "dbt Nightly build: Errored", category: "incident", detail: "Model orders failed" });
  });

  it("reads a Fivetran webhook", () => {
    const event = toEvent({ event: "sync_end", created: "2026-03-12T11:38:34.386Z", connector_id: "abc", data: { status: "SUCCESSFUL" } });
    expect(event).toMatchObject({ date: "2026-03-12", title: "Fivetran abc: sync_end (SUCCESSFUL)", category: "pipeline" });
  });

  it("reads an Airflow callback", () => {
    const event = toEvent({ dag_id: "daily_sales", task_id: "load", state: "failed", logical_date: "2026-03-12T00:00:00+00:00" });
    expect(event).toMatchObject({ date: "2026-03-12", title: "Airflow daily_sales.load: failed", category: "incident" });
  });

  it("uses today when the sender gives no date", () => {
    expect(toEvent({ title: "x" }, new Date("2026-05-01T12:00:00Z"))?.date).toBe("2026-05-01");
  });

  it("rejects a record with nothing to call it", () => {
    expect(toEvent({ foo: 1 })).toBeNull();
  });
});

describe("processBatch (Kafka delivery)", () => {
  const harness = (values: (string | null)[]) => {
    const resolved: string[] = [];
    let commits = 0;
    const payload: BatchPayload = {
      batch: { messages: values.map((value, i) => ({ offset: String(i), value: value === null ? null : Buffer.from(value) })) },
      resolveOffset: (offset) => resolved.push(offset),
      heartbeat: async () => {},
      commitOffsetsIfNecessary: async () => {
        commits++;
      },
      isRunning: () => true,
      isStale: () => false,
    };
    return { payload, resolved, commits: () => commits };
  };

  it("commits only after the write succeeds", async () => {
    const h = harness(['{"a":1}', '{"a":2}']);
    let written = 0;
    await processBatch(h.payload, async (records) => {
      expect(h.resolved).toEqual([]); // nothing acknowledged before the write
      written = records.length;
    });
    expect(written).toBe(2);
    expect(h.resolved).toEqual(["0", "1"]);
    expect(h.commits()).toBe(1);
  });

  it("does not commit when the write fails, so messages are redelivered", async () => {
    const h = harness(['{"a":1}']);
    await expect(
      processBatch(h.payload, async () => {
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    expect(h.resolved).toEqual([]);
    expect(h.commits()).toBe(0);
  });

  it("skips a poison message instead of blocking the partition", async () => {
    const h = harness(["{broken", '{"a":1}']);
    const outcome = await processBatch(h.payload, async (records, undecodable) => {
      expect(records).toEqual([{ a: 1 }]);
      expect(undecodable).toBe(1);
    });
    expect(outcome.undecodable).toBe(1);
    expect(h.resolved).toEqual(["0", "1"]);
  });

  it("acknowledges tombstones without writing a row", async () => {
    const h = harness([null]);
    await processBatch(h.payload, async (records) => expect(records).toEqual([]));
    expect(h.resolved).toEqual(["0"]);
  });

  it("stops reading once the consumer is shutting down", async () => {
    const h = harness(['{"a":1}', '{"a":2}']);
    let calls = 0;
    h.payload.isRunning = () => calls++ < 1;
    await processBatch(h.payload, async (records) => expect(records).toHaveLength(1));
    expect(h.resolved).toEqual(["0"]);
  });
});

describe("appending to a real table", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plumb-test-"));
  let api: typeof import("../src/lib/streams/append");
  let store: typeof import("../src/lib/store");
  let db: typeof import("../src/lib/db");
  let ingest: typeof import("../src/lib/ingest/ingest");
  let events: typeof import("../src/lib/timeline");

  const stream = async (dedupeKey: string | null = null, target: "table" | "events" = "table") => {
    const id = store.newId();
    await store.streams.save({ id, name: `s${id}`, kind: "http", target, dedupeKey, table: null, status: "active", createdAt: "2026-01-01", rowsReceived: 0, rowsDuplicate: 0, rowsRejected: 0, cellsRejected: 0, tokenHash: "x" });
    return id;
  };
  const rows = async (id: string) => {
    const saved = await store.streams.get(id);
    return db.query(`SELECT * FROM ${db.ident(saved!.table!)} ORDER BY ALL`);
  };

  beforeAll(async () => {
    process.env.PLUMB_DATA_DIR = dir;
    api = await import("../src/lib/streams/append");
    store = await import("../src/lib/store");
    db = await import("../src/lib/db");
    ingest = await import("../src/lib/ingest/ingest");
    events = await import("../src/lib/timeline");
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates the table from the first batch and appends the next", async () => {
    const id = await stream();
    await api.ingestRecords(id, [{ order: "A", amount: 10, ts: "2026-01-01T10:00:00Z" }]);
    const second = await api.ingestRecords(id, [{ order: "B", amount: 20, ts: "2026-01-02T10:00:00Z" }]);
    expect(second.accepted).toBe(1);
    expect(await rows(id)).toHaveLength(2);
    expect((await store.streams.get(id))?.rowsReceived).toBe(2);
  });

  it("adds a column when a new field appears", async () => {
    const id = await stream();
    await api.ingestRecords(id, [{ a: 1 }]);
    await api.ingestRecords(id, [{ a: 2, region: "West" }]);
    const all = await rows(id);
    expect(all.find((r) => Number(r.a) === 2)?.region).toBe("West");
    expect(all.find((r) => Number(r.a) === 1)?.region).toBeNull();
  });

  it("copes with a field going missing", async () => {
    const id = await stream();
    await api.ingestRecords(id, [{ a: 1, b: 2 }]);
    await api.ingestRecords(id, [{ a: 3 }]);
    expect((await rows(id)).find((r) => Number(r.a) === 3)?.b).toBeNull();
  });

  it("widens integer to decimal instead of losing the value", async () => {
    const id = await stream();
    await api.ingestRecords(id, [{ price: 10 }]);
    const result = await api.ingestRecords(id, [{ price: 10.5 }]);
    expect(result.rejectedCells).toBe(0);
    expect((await rows(id)).map((r) => Number(r.price))).toEqual([10, 10.5]);
  });

  it("widens date to timestamp", async () => {
    const id = await stream();
    await api.ingestRecords(id, [{ day: "2026-01-01" }]);
    await api.ingestRecords(id, [{ day: "2026-01-02 14:30:00" }]);
    expect(String((await rows(id))[1].day)).toContain("14:30:00");
  });

  it("keeps the row but counts a value that doesn't fit", async () => {
    const id = await stream();
    await api.ingestRecords(id, [{ n: 1, label: "ok" }]);
    const result = await api.ingestRecords(id, [{ n: "oops", label: "kept" }]);
    expect(result.rejectedCells).toBe(1);
    expect((await rows(id)).find((r) => r.label === "kept")?.n).toBeNull();
    expect((await store.streams.get(id))?.lastRejected?.[0]).toContain("oops");
  });

  it("drops redelivered rows with a dedupe key", async () => {
    const id = await stream("event_id");
    await api.ingestRecords(id, [{ event_id: 1, v: "a" }, { event_id: 2, v: "b" }]);
    const again = await api.ingestRecords(id, [{ event_id: 2, v: "b" }, { event_id: 3, v: "c" }]);
    expect(again).toMatchObject({ accepted: 1, duplicates: 1 });
    expect(await rows(id)).toHaveLength(3);
  });

  it("drops repeats inside one batch, including the first", async () => {
    const id = await stream("event_id");
    await api.ingestRecords(id, [{ event_id: 1 , v: "a"}, { event_id: 1, v: "a2" }]);
    const next = await api.ingestRecords(id, [{ event_id: 2, v: "b" }, { event_id: 2, v: "b2" }]);
    expect(next.accepted).toBe(1);
    expect(await rows(id)).toHaveLength(2);
  });

  it("keeps a user's fix applied as new rows arrive", async () => {
    const id = await stream();
    await api.ingestRecords(id, [{ city: "NYC", n: 1 }, { city: "LA", n: 2 }]);
    const table = (await store.streams.get(id))!.table!;
    const dataset = await store.datasets.get(table);
    await ingest.applyTransform(dataset!, { op: "map_values", column: "city", mapping: [{ from: "NYC", to: "New York" }] });
    await api.ingestRecords(id, [{ city: "NYC", n: 3 }]);
    const cities = (await rows(id)).map((r) => r.city);
    expect(cities).toEqual(["LA", "New York", "New York"]);
  });

  it("does not interleave concurrent batches", async () => {
    const id = await stream();
    await api.ingestRecords(id, [{ n: 0 }]);
    await Promise.all(Array.from({ length: 15 }, (_, i) => api.ingestRecords(id, [{ n: i + 1 }])));
    expect(await rows(id)).toHaveLength(16);
    expect((await store.streams.get(id))?.rowsReceived).toBe(16);
  });

  it("turns records into events on an events stream", async () => {
    const id = await stream(null, "events");
    const result = await api.ingestRecords(id, [{ title: "Deploy", date: "2026-02-02" }, { nothing: true }]);
    expect(result).toMatchObject({ accepted: 1, rejected: 1 });
    const listed = (await store.events.list()).filter((event) => event.streamId === id);
    expect(listed[0]).toMatchObject({ title: "Deploy", date: "2026-02-02", source: "stream" });
    void events;
  });
});

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plumb-metrics-"));
let ingest: typeof import("../src/lib/ingest/ingest");
let store: typeof import("../src/lib/store");
let metricsLib: typeof import("../src/lib/metrics");
let linksLib: typeof import("../src/lib/links");
let runner: typeof import("../src/lib/alerts/runner");
let db: typeof import("../src/lib/db");

const received: { text: string }[] = [];
let server: http.Server;
let hookUrl = "";

const day = (offset: number) => new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10);

beforeAll(async () => {
  process.env.PLUMB_DATA_DIR = dir;
  ingest = await import("../src/lib/ingest/ingest");
  store = await import("../src/lib/store");
  metricsLib = await import("../src/lib/metrics");
  linksLib = await import("../src/lib/links");
  runner = await import("../src/lib/alerts/runner");
  db = await import("../src/lib/db");

  // Customers C1-C3; orders mostly for them, plus one for a customer who doesn't exist.
  await ingest.ingestTable(
    { name: "customers", rows: [["customer_id", "plan", "id"], ["C1", "Pro", "1"], ["C2", "Basic", "2"], ["C3", "Basic", "3"]] },
    { kind: "file", name: "customers.csv" },
  );
  const orders: string[][] = [["order_id", "customer_id", "day", "revenue", "returned", "id"]];
  let n = 0;
  for (let d = 0; d < 21; d++) {
    for (let k = 0; k < 4; k++) orders.push([`O${++n}`, ["C1", "C2", "C3", "C1"][k], day(d), "100", k === 3 ? "true" : "false", String(n)]);
  }
  orders.push([`O${++n}`, "C9", day(5), "50", "false", String(n)]); // the orphan
  await ingest.ingestTable({ name: "orders", rows: orders }, { kind: "file", name: "orders.csv" });

  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  hookUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
});

afterAll(() => {
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("table links", () => {
  it("finds the customer link, measures orphans, and ignores coincidental id columns", async () => {
    const found = await linksLib.getLinks();
    const link = found.find((l) => l.fromTable === "orders" && l.toTable === "customers");
    expect(link).toMatchObject({ fromColumn: "customer_id", toColumn: "customer_id", cardinality: "many-to-one", orphans: 1 });
    expect(link!.coverage).toBeCloseTo(3 / 4); // C1, C2, C3 match; C9 doesn't
    // Both tables have an "id" column numbered 1, 2, 3. That's not a link.
    expect(found.some((l) => l.fromColumn === "id" || l.toColumn === "id")).toBe(false);
  });

  it("remembers a dismissal", async () => {
    const [link] = await linksLib.getLinks();
    await linksLib.dismissLink(link.id);
    expect((await linksLib.getLinks()).some((l) => l.id === link.id)).toBe(false);
    await linksLib.addLink(link); // adding it back by hand undoes the dismissal
    expect((await linksLib.getLinks()).some((l) => l.id === link.id && l.source === "user")).toBe(true);
  });

  it("refuses a link to a column that isn't one row per value", async () => {
    await expect(linksLib.addLink({ fromTable: "customers", fromColumn: "customer_id", toTable: "orders", toColumn: "customer_id" })).rejects.toThrow(/one row per value/);
  });
});

describe("metrics", () => {
  it("calculates an aggregate", async () => {
    expect(await metricsLib.evaluateMetric("orders", "SUM(revenue) FILTER (WHERE NOT returned)")).toBe(21 * 300 + 50);
  });

  it("refuses something that isn't one number", async () => {
    await expect(metricsLib.evaluateMetric("orders", "revenue")).rejects.toThrow(/one number/);
    await expect(metricsLib.evaluateMetric("orders", "SUM(nope)")).rejects.toThrow(/doesn't work/);
  });

  it("can't be used to change data", async () => {
    await expect(metricsLib.evaluateMetric("orders", `SUM(revenue)) AS value FROM orders; DROP TABLE orders; SELECT (1`)).rejects.toThrow();
    const [{ n }] = await db.query(`SELECT COUNT(*) AS n FROM orders`);
    expect(Number(n)).toBe(85);
  });

  it("splits by a linked table's column without inflating the total", async () => {
    const now = new Date().toISOString();
    await store.metrics.save({ id: "net", name: "Net revenue", table: "orders", expression: "SUM(revenue) FILTER (WHERE NOT returned)", format: "currency", currency: "$", source: "user", createdAt: now, updatedAt: now });
    const metric = await metricsLib.findMetric("net revenue");
    const { sql, spec } = await metricsLib.metricSql({ metric, groupBy: "customers.plan" });
    const rows = await db.query(sql);
    const byPlan = Object.fromEntries(rows.map((r) => [String(r.plan), Number(r.value)]));
    // C1 is Pro (one kept order a day); C2 and C3 are Basic; C9 has no customer.
    expect(byPlan).toEqual({ Pro: 2100, Basic: 4200, null: 50 });
    expect(rows.reduce((sum, r) => sum + Number(r.value), 0)).toBe(21 * 300 + 50);
    expect(spec.type).toBe("hbar");
  });

  it("explains a missing link", async () => {
    const metric = await metricsLib.findMetric("Net revenue");
    await expect(metricsLib.metricSql({ metric, groupBy: "nowhere.plan" })).rejects.toThrow(/no link/);
  });

  it("builds a trend", async () => {
    const metric = await metricsLib.findMetric("Net revenue");
    const { sql } = await metricsLib.metricSql({ metric, dateColumn: "day", grain: "week" });
    expect((await db.query(sql)).length).toBeGreaterThan(2);
  });
});

describe("alerts end to end", () => {
  it("fires once to the webhook, stays quiet while it continues, and reports when it clears", async () => {
    await store.notifications.save({ id: "notifications", webhookUrl: hookUrl, format: "slack" });
    const now = new Date().toISOString();
    await store.alerts.save({
      id: "drop",
      name: "Revenue drop",
      kind: "change",
      enabled: true,
      metricId: "net",
      dateColumn: "day",
      grain: "day",
      changePct: 30,
      direction: "drop",
      notifyResolved: true,
      status: "pending",
      createdAt: now,
    });

    // Steady data: nothing fires.
    let rule = await runner.checkAlert("drop");
    expect(rule?.status).toBe("ok");
    expect(received).toHaveLength(0);

    // The last day loses most of its revenue.
    await db.exec(`DELETE FROM orders WHERE day = DATE '${day(20)}' AND customer_id IN ('C2', 'C3')`);
    rule = await runner.checkAlert("drop");
    expect(rule?.status).toBe("firing");
    expect(received).toHaveLength(1);
    expect(received[0].text).toMatch(/^\[Plumb\] Revenue drop: Net revenue fell 66\.7%/);
    expect(received[0].text).not.toMatch(/C1|C2|C3|O\d/); // numbers and dates only, no row data

    // Checking again with nothing new: no repeat message.
    await runner.checkAlert("drop");
    expect(received).toHaveLength(1);

    // Revenue comes back: it clears, and that's reported.
    await db.exec(`INSERT INTO orders SELECT 'X' || i, 'C2', DATE '${day(20)}', 100, false, 1000 + i FROM range(2) t(i)`);
    rule = await runner.checkAlert("drop");
    expect(rule?.status).toBe("ok");
    expect(received).toHaveLength(2);
    expect(received[1].text).toMatch(/^\[Plumb\] Cleared: Revenue drop/);

    const history = await store.alertHistory.list();
    expect(history.map((h) => h.status).sort()).toEqual(["firing", "resolved"]);
    expect(history.every((h) => h.delivery === "sent")).toBe(true);
  });

  it("reports a broken rule as an error, once", async () => {
    await store.alerts.save({ id: "broken", name: "Broken", kind: "change", enabled: true, metricId: "missing", dateColumn: "day", changePct: 10, notifyResolved: true, status: "pending", createdAt: new Date().toISOString() });
    const first = await runner.checkAlert("broken");
    expect(first?.status).toBe("error");
    expect(first?.message).toMatch(/No metric/);
    await runner.checkAlert("broken");
    expect((await store.alertHistory.list()).filter((h) => h.alertId === "broken")).toHaveLength(1);
  });

  it("fires for a new incident and not again for the same one", async () => {
    const created = new Date().toISOString();
    await store.alerts.save({ id: "inc", name: "Pipeline failures", kind: "incident", enabled: true, notifyResolved: false, status: "pending", createdAt: new Date(Date.now() - 1000).toISOString() });
    await store.events.save({ id: "e1", date: day(20), title: "dbt Nightly: Errored", category: "incident", source: "stream", createdAt: created, table: null });
    const before = received.length;
    expect((await runner.checkAlert("inc"))?.status).toBe("firing");
    expect(received.length).toBe(before + 1);
    expect(received.at(-1)!.text).toContain("dbt Nightly: Errored");
    await runner.checkAlert("inc");
    expect(received.length).toBe(before + 1);
  });
});

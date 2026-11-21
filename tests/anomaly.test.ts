import { describe, expect, it } from "vitest";
import { chanceOfSoFew, detectAnomalies, eventImpact, expectedValues } from "../src/lib/ml/anomaly";
import { addPeriods } from "../src/lib/ml/forecast";

const seeded = (seed: number) => () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};
const days = (n: number) => Array.from({ length: n }, (_, i) => addPeriods("2024-01-01", "day", i));

/** A trending series with a weekend bump and noise. */
function dailySeries(n: number, seed = 7) {
  const random = seeded(seed);
  return Array.from({ length: n }, (_, i) => {
    const weekday = new Date(Date.UTC(2024, 0, 1 + i)).getUTCDay();
    return (100 + i * 0.2) * (weekday === 0 || weekday === 6 ? 1.4 : 1) * (1 + (random() - 0.5) * 0.1);
  });
}

describe("detectAnomalies", () => {
  it("finds planted spikes and drops, and nothing else", () => {
    const values = dailySeries(300);
    values[120] *= 3;
    values[200] = 0;
    const { anomalies } = detectAnomalies(days(300), values, "day");
    expect(anomalies.map((a) => a.date).sort()).toEqual([days(300)[120], days(300)[200]].sort());
    expect(anomalies.find((a) => a.date === days(300)[120])?.direction).toBe("spike");
    expect(anomalies.find((a) => a.date === days(300)[200])?.direction).toBe("drop");
  });

  it("sees drops as well as spikes in skewed, sales-like data", () => {
    const random = seeded(21);
    const normal = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
    const values = Array.from({ length: 700 }, () => 1000 * Math.exp(normal() * 0.45));
    values[300] = 10; // a real outage
    values[500] *= 12; // a real surge
    const { anomalies } = detectAnomalies(days(700), values, "day");
    const dates = anomalies.map((a) => a.date);
    expect(dates).toContain(days(700)[300]);
    expect(dates).toContain(days(700)[500]);
    expect(anomalies.find((a) => a.date === days(700)[300])?.direction).toBe("drop");
    expect(anomalies.length).toBeLessThan(7); // under 1% of days flagged
  });

  it("allows for a noisy quiet period before a busy one", () => {
    const random = seeded(4);
    const values = Array.from({ length: 400 }, (_, i) => (i < 200 ? 50 * (1 + (random() - 0.5) * 1.2) : 500 * (1 + (random() - 0.5) * 0.1)));
    // Stops short of the jump: the 116-day noise window straddles it after this point.
    const quiet = detectAnomalies(days(400), values, "day").anomalies.filter((a) => a.date < days(400)[140]);
    expect(quiet).toEqual([]);
  });

  it("raises the bar when asked", () => {
    const values = dailySeries(200);
    values[100] *= 1.6;
    const strict = detectAnomalies(days(200), values, "day", 50).anomalies;
    expect(strict).toEqual([]);
  });

  it("does not flag ordinary weekends", () => {
    const { anomalies } = detectAnomalies(days(200), dailySeries(200), "day");
    expect(anomalies).toEqual([]);
  });

  it("does not flag a smooth trend", () => {
    const values = Array.from({ length: 100 }, (_, i) => 50 + i * 3);
    expect(detectAnomalies(days(100), values, "day").anomalies).toEqual([]);
  });

  it("handles a flat series without dividing by zero", () => {
    expect(detectAnomalies(days(30), new Array(30).fill(0), "day").anomalies).toEqual([]);
  });

  it("does not flag the normal peak of a seasonal monthly series", () => {
    const dates = Array.from({ length: 48 }, (_, i) => addPeriods("2022-01-01", "month", i));
    const values = dates.map((_, i) => (100 + i) * (1 + 0.4 * Math.cos((2 * Math.PI * i) / 12)));
    expect(detectAnomalies(dates, values, "month").anomalies).toEqual([]);
  });

  it("does not guess from too little data", () => {
    expect(detectAnomalies(days(10), [1, 1, 1, 1, 100, 1, 1, 1, 1, 1], "day").anomalies).toEqual([]);
  });

  it("keeps the baseline honest when a spike is present", () => {
    const values = dailySeries(100);
    const clean = expectedValues(values, "day")[50];
    values[50] *= 10;
    expect(Math.abs(expectedValues(values, "day")[50] - clean) / clean).toBeLessThan(0.05);
  });
});

describe("eventImpact", () => {
  const random = seeded(3);
  const noise = (n: number) => Array.from({ length: n }, () => 100 + (random() - 0.5) * 20);

  it("calls a real step change clear", () => {
    const values = noise(200).map((v, i) => (i >= 100 ? v + 30 : v));
    const result = eventImpact({ dates: days(200), values, grain: "day", eventDate: days(200)[100] });
    expect(result.verdict).toBe("clear");
    expect(result.change).toBeGreaterThan(20);
  });

  it("finds no effect when nothing changed", () => {
    const result = eventImpact({ dates: days(200), values: noise(200), grain: "day", eventDate: days(200)[100] });
    expect(["none", "weak"]).toContain(result.verdict);
  });

  it("does not credit an event for an ordinary seasonal rise", () => {
    const dates = Array.from({ length: 60 }, (_, i) => addPeriods("2021-01-01", "month", i));
    const values = dates.map((_, i) => 100 + 40 * Math.sin((2 * Math.PI * i) / 12));
    const result = eventImpact({ dates, values, grain: "month", eventDate: dates[30] });
    expect(result.verdict).not.toBe("clear");
  });

  it("uses whole weeks, so weekday mix can't fake a change", () => {
    const result = eventImpact({ dates: days(100), values: dailySeries(100), grain: "day", eventDate: days(100)[50], window: 10 });
    expect(result.window % 7).toBe(0);
  });

  it("refuses when the event is at the edge of the data", () => {
    expect(eventImpact({ dates: days(100), values: noise(100), grain: "day", eventDate: "2030-01-01" }).verdict).toBe("insufficient");
    expect(eventImpact({ dates: days(100), values: noise(100), grain: "day", eventDate: days(100)[0] }).verdict).toBe("insufficient");
    expect(eventImpact({ dates: days(100), values: noise(100), grain: "day", eventDate: days(100)[99] }).verdict).toBe("insufficient");
  });
});

describe("chanceOfSoFew", () => {
  it("matches known Poisson values", () => {
    expect(chanceOfSoFew(0, 2)).toBeCloseTo(Math.exp(-2));
    expect(chanceOfSoFew(1, 2)).toBeCloseTo(3 * Math.exp(-2));
  });

  it("says an empty day is ordinary at low volume and rare at high volume", () => {
    expect(chanceOfSoFew(0, 2)).toBeGreaterThan(0.1);
    expect(chanceOfSoFew(0, 20)).toBeLessThan(0.000001);
  });

  it("never exceeds certainty", () => {
    expect(chanceOfSoFew(1000, 2)).toBeLessThanOrEqual(1);
  });
});

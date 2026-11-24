import { describe, expect, it } from "vitest";
import { checkAnomaly, checkChange, checkStale, checkThreshold, completePeriods, transition, webhookBody, type Series } from "../src/lib/alerts/rules";
import { addPeriods } from "../src/lib/ml/forecast";

const daily = (values: number[], start = "2026-01-01"): Series => ({
  dates: values.map((_, i) => addPeriods(start, "day", i)),
  values,
  grain: "day",
  label: "Net revenue",
});

describe("completePeriods", () => {
  it("drops today, which is still filling up", () => {
    const series = daily([10, 10, 3]); // the 3rd is "today"
    expect(completePeriods(series, "2026-01-03").values).toEqual([10, 10]);
  });

  it("keeps yesterday, which is finished", () => {
    expect(completePeriods(daily([10, 10, 3]), "2026-01-04").values).toEqual([10, 10, 3]);
  });

  it("drops an unfinished month", () => {
    const monthly: Series = { dates: ["2026-01-01", "2026-02-01"], values: [5, 1], grain: "month", label: "x" };
    expect(completePeriods(monthly, "2026-02-15").dates).toEqual(["2026-01-01"]);
    expect(completePeriods(monthly, "2026-03-01").dates).toEqual(["2026-01-01", "2026-02-01"]);
  });
});

describe("checkChange", () => {
  it("compares a day with the same weekday a week earlier", () => {
    const values = [100, 100, 100, 100, 100, 50, 50, 100, 100, 100, 100, 100, 50, 30];
    const result = checkChange({ changePct: 20, direction: "drop" }, daily(values));
    // The last day (30) is compared with 7 days earlier (50), not with yesterday (50 too) by luck:
    expect(result.status).toBe("firing");
    expect(result.message).toContain("fell 40.0%");
    expect(result.message).toContain("same weekday");
    expect(result.key).toBe("2026-01-14");
  });

  it("doesn't call a normal weekend a drop", () => {
    const week = [100, 100, 100, 100, 100, 40, 40];
    const steady = checkChange({ changePct: 20, direction: "drop" }, daily([...week, ...week]));
    expect(steady.status).toBe("ok");
    expect(steady.message).toMatch(/was unchanged at/);
  });

  it("respects direction", () => {
    const series = daily([100, 100, 100, 100, 100, 100, 100, 150]);
    expect(checkChange({ changePct: 20, direction: "drop" }, series).status).toBe("ok");
    expect(checkChange({ changePct: 20, direction: "rise" }, series).status).toBe("firing");
    expect(checkChange({ changePct: 20, direction: "any" }, series).status).toBe("firing");
  });

  it("needs enough history and refuses to divide by zero", () => {
    expect(checkChange({ changePct: 10 }, daily([1, 2, 3])).status).toBe("ok");
    expect(checkChange({ changePct: 10 }, daily([0, 1, 1, 1, 1, 1, 1, 5])).message).toContain("was zero");
  });
});

describe("checkThreshold", () => {
  it("fires above or below a limit", () => {
    expect(checkThreshold({ op: "below", value: 60 }, daily([100, 50])).status).toBe("firing");
    expect(checkThreshold({ op: "below", value: 40 }, daily([100, 50])).status).toBe("ok");
    expect(checkThreshold({ op: "above", value: 60 }, daily([50, 100])).status).toBe("firing");
  });
});

describe("checkAnomaly", () => {
  it("fires when the latest day is unusual, in the chosen direction", () => {
    const values = Array.from({ length: 60 }, (_, i) => 100 + (i % 7) * 2 + ((i * 37) % 11));
    values[59] = 10;
    expect(checkAnomaly({ direction: "any" }, daily(values)).status).toBe("firing");
    expect(checkAnomaly({ direction: "drop" }, daily(values)).status).toBe("firing");
    expect(checkAnomaly({ direction: "rise" }, daily(values)).status).toBe("ok");
  });
});

describe("checkStale", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  it("fires after the limit", () => {
    expect(checkStale({ staleMinutes: 60, table: "orders" }, "2026-01-01T10:00:00Z", now).status).toBe("firing");
    expect(checkStale({ staleMinutes: 60, table: "orders" }, "2026-01-01T11:30:00Z", now).status).toBe("ok");
  });
});

describe("transition", () => {
  const fired = { message: "x", value: 1 };
  it("fires once per breach, and again for a new period", () => {
    expect(transition({ status: "ok", firedKey: null, kind: "change" }, { ...fired, status: "firing", key: "2026-01-14" })).toBe("fire");
    expect(transition({ status: "firing", firedKey: "2026-01-14", kind: "change" }, { ...fired, status: "firing", key: "2026-01-14" })).toBe("none");
    expect(transition({ status: "firing", firedKey: "2026-01-14", kind: "change" }, { ...fired, status: "firing", key: "2026-01-15" })).toBe("fire");
  });

  it("resolves when it clears, but not for one-off incidents", () => {
    expect(transition({ status: "firing", firedKey: "k", kind: "change" }, { ...fired, status: "ok", key: null })).toBe("resolve");
    expect(transition({ status: "firing", firedKey: "k", kind: "incident" }, { ...fired, status: "ok", key: null })).toBe("none");
    expect(transition({ status: "ok", firedKey: null, kind: "change" }, { ...fired, status: "ok", key: null })).toBe("none");
  });

  it("reports an error once", () => {
    expect(transition({ status: "ok", firedKey: null, kind: "change" }, { status: "error" })).toBe("error");
    expect(transition({ status: "error", firedKey: null, kind: "change" }, { status: "error" })).toBe("none");
  });
});

describe("webhookBody", () => {
  it("matches each tool's format", () => {
    expect(webhookBody("slack", "hi", { a: 1 })).toEqual({ text: "hi" });
    expect(webhookBody("discord", "hi", { a: 1 })).toEqual({ content: "hi" });
    expect(webhookBody("json", "hi", { a: 1 })).toEqual({ text: "hi", a: 1 });
    expect((webhookBody("discord", "x".repeat(3000), {}).content as string).length).toBe(2000);
  });
});

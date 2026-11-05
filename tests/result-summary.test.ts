import { describe, expect, it } from "vitest";
import { summarizeResult } from "../src/lib/ai/result-summary";
import { formatValue } from "../src/lib/format";

const months = (count: number) => Array.from({ length: count }, (_, i) => ({ month: `m${i}`, revenue: i + 1 }));

describe("summarizeResult", () => {
  it("keeps every row of a normal result", () => {
    const text = summarizeResult(months(44));
    expect(text).toContain("44 rows in total, all shown");
    expect(text).toContain('"m43"'); // the real last period, not row 40
  });

  it("shows both ends of a long result and says what is missing", () => {
    const text = summarizeResult(months(1000));
    expect(text).toContain("1000 rows in total");
    expect(text).toContain("940 rows in the middle are not shown");
    expect(text).toContain('"m0"');
    expect(text).toContain('"m999"');
    expect(text).not.toContain('"m500"');
  });

  it("gives totals over every row, including the hidden ones", () => {
    const text = summarizeResult(months(1000));
    expect(text).toContain('"sum":500500');
    expect(text).toContain('"max":1000');
  });

  it("flags a result that hit the row limit", () => {
    expect(summarizeResult(months(3), true)).toContain("3 or more rows");
  });
});

describe("percent values", () => {
  it("treats the value as already being a percentage", () => {
    expect(formatValue(6.57, "percent")).toBe("6.6%");
    expect(formatValue(0.9, "percent")).toBe("0.9%"); // used to display as 90%
  });
});

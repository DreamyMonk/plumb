import { describe, expect, it } from "vitest";
import { cleanTable, detectHeaderRow, parseDate, parseNumber, toColumnName } from "../src/lib/ingest/clean";

const col = (r: ReturnType<typeof cleanTable>, name: string) => r.columns.find((c) => c.name === name)!;

describe("parseNumber", () => {
  it.each([
    ["1,234.50", 1234.5],
    ["$1,234", 1234],
    ["(1,200)", -1200],
    ["-$5.00", -5],
    ["1.5k", 1500],
    ["2M", 2000000],
    ["12,34,567", 1234567],
    ["45%", 45],
    ["1 234", 1234],
    ["1e3", 1000],
  ])("reads %s", (input, expected) => {
    expect(parseNumber(input)?.value).toBe(expected);
  });

  it("reads European decimals when told to", () => {
    expect(parseNumber("1.234,56", true)?.value).toBe(1234.56);
  });

  it.each(["abc", "12 (est)", "1,2,3", "12/03", "1.2.3"])("rejects %s", (input) => {
    expect(parseNumber(input)).toBeNull();
  });

  it("captures the unit", () => {
    expect(parseNumber("€10")?.unit).toBe("€");
    expect(parseNumber("10%")?.unit).toBe("%");
  });
});

describe("parseDate", () => {
  it.each([
    ["2024-03-05", "2024-03-05"],
    ["2024/3/5", "2024-03-05"],
    ["03/05/2024", "2024-03-05"],
    ["5 Mar 2024", "2024-03-05"],
    ["05-Mar-24", "2024-03-05"],
    ["March 5, 2024", "2024-03-05"],
    ["Sept 5 2024", "2024-09-05"],
    ["Mar 2024", "2024-03-01"],
  ])("reads %s", (input, expected) => {
    expect(parseDate(input)?.date).toBe(expected);
  });

  it("honours day-first", () => {
    expect(parseDate("03/05/2024", true)?.date).toBe("2024-05-03");
  });

  it("rejects impossible dates", () => {
    expect(parseDate("2024-02-30")).toBeNull();
    expect(parseDate("13/13/2024")).toBeNull();
  });

  it("keeps wall-clock time from database timestamps with an offset", () => {
    expect(parseDate("2024-01-15 10:30:00+00")?.time).toBe("10:30:00");
    expect(parseDate("2024-01-15 10:30:00.123+05:30")?.time).toBe("10:30:00");
  });

  it("reads times", () => {
    expect(parseDate("2024-03-05 2:30 PM")?.time).toBe("14:30:00");
    expect(parseDate("2024-03-05T14:30:00Z")?.time).toBe("14:30:00");
  });
});

describe("toColumnName", () => {
  it("makes SQL-friendly names", () => {
    expect(toColumnName("Order Date", 0)).toBe("order_date");
    expect(toColumnName("unitPrice", 0)).toBe("unit_price");
    expect(toColumnName("Growth %", 0)).toBe("growth_pct");
    expect(toColumnName("2024 Sales", 0)).toBe("c_2024_sales");
    expect(toColumnName("", 3)).toBe("column_4");
  });
});

describe("detectHeaderRow", () => {
  it("skips a report title above the table", () => {
    expect(detectHeaderRow([["Q3 Sales Report", "", ""], ["", "", ""], ["Region", "Rep", "Sales"], ["West", "Ann", "10"]])).toBe(2);
  });
  it("defaults to the first row", () => {
    expect(detectHeaderRow([["a", "b"], ["1", "2"]])).toBe(0);
  });
});

describe("cleanTable", () => {
  it("infers types and strips formatting", () => {
    const r = cleanTable([
      ["Order Date", "Revenue", "Active", "Name"],
      ["2024-01-05", "$1,000.50", "Yes", "Ann"],
      ["1/6/2024", "$2,000", "No", "Bob"],
    ]);
    expect(col(r, "order_date").type).toBe("date");
    expect(col(r, "order_date").values).toEqual(["2024-01-05", "2024-01-06"]);
    expect(col(r, "revenue").type).toBe("number");
    expect(col(r, "revenue").unit).toBe("$");
    expect(col(r, "active").values).toEqual(["true", "false"]);
  });

  it("keeps leading-zero codes as text", () => {
    const r = cleanTable([["zip", "qty"], ["02134", "1"], ["10001", "2"]]);
    expect(col(r, "zip").type).toBe("text");
    expect(col(r, "zip").values[0]).toBe("02134");
    expect(col(r, "qty").type).toBe("integer");
  });

  it("does not treat plain integers as dates", () => {
    const r = cleanTable([["year", "n"], ["2020", "1"], ["2021", "2"]]);
    expect(col(r, "year").type).toBe("integer");
  });

  it("turns null tokens into missing values", () => {
    const r = cleanTable([["a", "b"], ["1", "x"], ["N/A", "y"], ["-", "z"]]);
    expect(col(r, "a").values).toEqual(["1", null, null]);
  });

  it("removes duplicates, blank rows, repeats and totals", () => {
    const r = cleanTable([
      ["region", "sales"],
      ["West", "10"],
      ["West", "10"],
      ["", ""],
      ["region", "sales"],
      ["East", "20"],
      ["Total", "40"],
    ]);
    expect(r.rowCount).toBe(2);
    const kinds = r.report.actions.map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(["duplicates", "empty_rows", "repeat_headers", "totals"]));
  });

  it("merges case variants to the most common spelling", () => {
    const r = cleanTable([["country", "id"], ["USA", "1"], ["USA", "2"], ["usa", "3"], ["U.S.A", "4"], ["Canada", "5"]]);
    expect(col(r, "country").values).toEqual(["USA", "USA", "USA", "USA", "Canada"]);
  });

  it("blanks a few bad values in a numeric column and reports them", () => {
    const rows = [["amount"], ...Array.from({ length: 30 }, (_, i) => [String(i)]), ["oops"]];
    const r = cleanTable(rows);
    expect(col(r, "amount").type).toBe("integer");
    const action = r.report.actions.find((a) => a.kind === "unparseable")!;
    expect(action.count).toBe(1);
    expect(action.examples).toEqual(["oops"]);
    expect(action.severity).toBe("warn");
  });

  it("leaves a genuinely mixed column as text", () => {
    const r = cleanTable([["v"], ["1"], ["two"], ["3"], ["four"]]);
    expect(col(r, "v").type).toBe("text");
  });

  it("detects European number format at column level", () => {
    const r = cleanTable([["price"], ["1.234,50"], ["99,95"], ["10,00"]]);
    expect(col(r, "price").values).toEqual(["1234.5", "99.95", "10"]);
  });

  it("reads day-first dates when a value proves the order", () => {
    const r = cleanTable([["d"], ["25/12/2024"], ["03/04/2024"]]);
    expect(col(r, "d").values).toEqual(["2024-12-25", "2024-04-03"]);
  });

  it("warns when date order cannot be proven", () => {
    const r = cleanTable([["d"], ["01/02/2024"], ["03/04/2024"]]);
    expect(r.report.actions.some((a) => a.kind === "ambiguous_dates")).toBe(true);
  });

  it("drops empty columns and dedupes names", () => {
    const r = cleanTable([["a", "", "a"], ["1", "", "2"]]);
    expect(r.columns.map((c) => c.name)).toEqual(["a", "a_2"]);
  });

  it("scores quality higher after cleaning", () => {
    const r = cleanTable([["a", "b"], ["$1", "x"], ["$1", "x"], ["$2", " y "]]);
    expect(r.report.qualityAfter.score).toBeGreaterThan(r.report.qualityBefore.score);
  });

  it("handles an empty file without throwing", () => {
    const r = cleanTable([]);
    expect(r.rowCount).toBe(0);
    expect(r.columns).toEqual([]);
  });
});

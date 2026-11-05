import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { csvCell } from "../src/lib/format";
import { cleanTable } from "../src/lib/ingest/clean";
import { decodeText, detectDelimiter, objectsToRows, parseFile } from "../src/lib/ingest/parse";

describe("detectDelimiter", () => {
  it.each([
    ["a,b\n1,2\n", ","],
    ["a\tb\n1\t2\n3\t4\n", "\t"],
    ["a;b;c\n1,5;2,5;3\n", ";"],
    ["a|b\n1|2\n", "|"],
    ["only one column\nsecond line\n", ","],
  ])("reads %j", (text, expected) => {
    expect(detectDelimiter(text)).toBe(expected);
  });

  it("ignores commas inside quotes", () => {
    expect(detectDelimiter('name;note\n"Smith, John";x\n"Doe, Jane";y\n')).toBe(";");
  });

  it("copes with a title line above the table", () => {
    expect(detectDelimiter("Sales report\na\tb\tc\n1\t2\t3\n4\t5\t6\n")).toBe("\t");
  });
});

describe("decodeText", () => {
  it("handles UTF-16, BOMs and Windows-1252", () => {
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Zoë", "utf16le")]))).toBe("Zoë");
    expect(decodeText(Buffer.from("﻿abc"))).toBe("abc");
    expect(decodeText(Buffer.from("Café", "latin1"))).toBe("Café");
  });
});

describe("Excel dates", () => {
  // Excel stores dates as timezone-less serials. Built that way here, because a JS Date
  // fixture would be shifted by the machine's timezone and prove nothing.
  it("keeps the calendar date in any timezone", () => {
    const sheet: XLSX.WorkSheet = {
      "!ref": "A1:B3",
      A1: { t: "s", v: "Day" },
      B1: { t: "s", v: "Stamp" },
      A2: { t: "n", v: 45306, z: "yyyy-mm-dd" },
      B2: { t: "n", v: 45306.5, z: "yyyy-mm-dd hh:mm" },
      A3: { t: "n", v: 45351, z: "m/d/yy" },
      B3: { t: "n", v: 45351.75, z: "yyyy-mm-dd hh:mm" },
    };
    const buffer = XLSX.write({ SheetNames: ["S"], Sheets: { S: sheet } }, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const [table] = parseFile("dates.xlsx", buffer);
    const result = cleanTable(table.rows);
    expect(result.columns[0].type).toBe("date");
    expect(result.columns[0].values).toEqual(["2024-01-15", "2024-02-29"]);
    expect(result.columns[1].values).toEqual(["2024-01-15 12:00:00", "2024-02-29 18:00:00"]);
  });

  it("turns each non-empty sheet into a table", () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["a"], [1]]), "One");
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["b"], [2]]), "Two");
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([]), "Empty");
    const tables = parseFile("book.xlsx", XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer);
    expect(tables.map((t) => t.sheet)).toEqual(["One", "Two"]);
  });
});

describe("JSON", () => {
  it("flattens nested objects and takes the union of keys", () => {
    const rows = objectsToRows([{ id: 1, user: { name: "A" } }, { id: 2, extra: true }]);
    expect(rows[0]).toEqual(["id", "user_name", "extra"]);
    expect(rows[2]).toEqual(["2", null, "true"]);
  });

  it("finds the records inside a wrapper object", () => {
    const [table] = parseFile("a.json", Buffer.from(JSON.stringify({ meta: {}, results: [{ a: 1 }, { a: 2 }] })));
    expect(table.rows).toEqual([["a"], ["1"], ["2"]]);
  });

  it("reads newline-delimited JSON", () => {
    const [table] = parseFile("a.ndjson", Buffer.from('{"a":1}\n{"a":2}\n'));
    expect(table.rows).toHaveLength(3);
  });

  it("explains bad JSON in plain words", () => {
    expect(() => parseFile("a.json", Buffer.from("{not json"))).toThrow(/not valid JSON/);
  });
});

describe("parseFile", () => {
  it("rejects unsupported files", () => {
    expect(() => parseFile("a.pdf", Buffer.from("x"))).toThrow(/not a supported file/);
  });
});

describe("booleans", () => {
  it("does not read a lone letter as a boolean", () => {
    const result = cleanTable([["code"], ["y"], [""], ["y"]]);
    expect(result.columns[0].type).toBe("text");
  });

  it("accepts single letters when both sides appear", () => {
    expect(cleanTable([["flag"], ["y"], ["n"]]).columns[0].type).toBe("boolean");
  });

  it("accepts whole words with only one side", () => {
    expect(cleanTable([["flag"], ["yes"], ["yes"]]).columns[0].type).toBe("boolean");
  });
});

describe("csvCell", () => {
  it.each(["=1+1", "+1", "-1", "@cmd", '=HYPERLINK("http://x")'])("neutralizes the formula %s", (input) => {
    expect(csvCell(input).replace(/^"/, "")[0]).toBe("'");
  });

  it("leaves real numbers and ordinary text alone", () => {
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell("hello")).toBe("hello");
  });

  it("quotes separators", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(null)).toBe("");
  });
});

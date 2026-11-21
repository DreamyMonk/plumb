import { describe, expect, it } from "vitest";
import { effectiveKind, isCard, isPhone, kindFromName, kindFromValues, luhn } from "../src/lib/privacy/detect";
import { Masker, streamUnmasker } from "../src/lib/privacy/masker";

const key = Buffer.alloc(32, 7);

describe("kindFromName", () => {
  it.each([
    ["email", "text", "email"],
    ["customer_email", "text", "email"],
    ["e_mail", "text", "email"],
    ["phone", "text", "phone"],
    ["mobile_number", "text", "phone"],
    ["full_name", "text", "name"],
    ["first_name", "text", "name"],
    ["customer_name", "text", "name"],
    ["name", "text", "name"],
    ["street_address", "text", "address"],
    ["zip_code", "integer", "postcode"],
    ["ssn", "text", "govid"],
    ["iban", "text", "card"],
    ["ip_address", "text", "ip"],
    ["date_of_birth", "date", "dob"],
  ] as const)("%s (%s) is %s", (name, type, kind) => {
    expect(kindFromName(name, type)).toBe(kind);
  });

  it.each([
    ["product_name", "text"],
    ["company_name", "text"],
    ["email_opt_in", "boolean"],
    ["email_count", "integer"],
    ["phone_calls", "integer"],
    ["region", "text"],
    ["revenue", "number"],
  ] as const)("leaves %s (%s) alone", (name, type) => {
    expect(kindFromName(name, type)).toBeNull();
  });
});

describe("kindFromValues", () => {
  const many = (make: (i: number) => string, n = 60) => Array.from({ length: n }, (_, i) => make(i));
  const FIRST = ["Ada", "Grace", "Alan", "Linus", "Margaret", "Dennis", "Barbara", "Ken"];
  const LAST = ["Lovelace", "Hopper", "Turing", "Torvalds", "Hamilton", "Ritchie", "Liskov", "Thompson"];

  it("spots emails, phones, cards, SSNs and IPs", () => {
    expect(kindFromValues(many((i) => `user${i}@example.com`))).toBe("email");
    expect(kindFromValues(many((i) => `+1 (555) 010-${String(1000 + i)}`))).toBe("phone");
    expect(kindFromValues(many(() => "4111 1111 1111 1111"))).toBe("card");
    expect(kindFromValues(many((i) => `123-45-${String(1000 + i)}`))).toBe("govid");
    expect(kindFromValues(many((i) => `10.0.0.${i}`))).toBe("ip");
  });

  it("spots person names only when there are many distinct ones", () => {
    expect(kindFromValues(many((i) => `${FIRST[i % 8]} ${LAST[Math.floor(i / 8) % 8]}`))).toBe("name");
    expect(kindFromValues(many((i) => ["Smart Speaker", "Desk Lamp", "Trail Backpack"][i % 3]))).toBeNull();
  });

  it("does not mistake ordinary values", () => {
    expect(kindFromValues(many((i) => `2026-01-${String((i % 28) + 1).padStart(2, "0")}`))).toBeNull();
    expect(kindFromValues(many((i) => String(1000 + i)))).toBeNull();
    expect(kindFromValues(many(() => "West"))).toBeNull();
  });
});

describe("checks", () => {
  it("validates card check digits", () => {
    expect(luhn("4111111111111111")).toBe(true);
    expect(luhn("4111111111111112")).toBe(false);
    expect(isCard("4111-1111-1111-1111")).toBe(true);
    expect(isCard("1234567812345678")).toBe(false);
  });

  it("tells phones from dates and amounts", () => {
    expect(isPhone("+44 20 7946 0958")).toBe(true);
    expect(isPhone("(555) 010-1234")).toBe(true);
    expect(isPhone("2026-03-12")).toBe(false);
    expect(isPhone("12345")).toBe(false);
    expect(isPhone("5551234567")).toBe(false); // no separators: too easily an ordinary number
  });
});

describe("Masker", () => {
  it("gives a value the same token every time, and the token reveals nothing", () => {
    const a = new Masker(key);
    const b = new Masker(key);
    const token = a.token("email", "jane@example.com");
    expect(token).toMatch(/^email_[0-9a-f]{6}$/);
    expect(b.token("email", "jane@example.com")).toBe(token);
    expect(token).not.toContain("jane");
    expect(new Masker(Buffer.alloc(32, 9)).token("email", "jane@example.com")).not.toBe(token);
  });

  it("unmasks text and SQL, with quotes escaped for SQL", () => {
    const m = new Masker(key);
    const t = m.token("name", "Conan O'Brien");
    expect(m.unmask(`Top customer: ${t}.`)).toBe("Top customer: Conan O'Brien.");
    expect(m.unmaskSql(`SELECT * FROM c WHERE full_name = '${t}'`)).toBe("SELECT * FROM c WHERE full_name = 'Conan O''Brien'");
  });

  it("leaves unknown tokens alone", () => {
    expect(new Masker(key).unmask("email_abcdef")).toBe("email_abcdef");
  });

  it("scrubs personal data found by shape in free text", () => {
    const m = new Masker(key);
    const out = m.scrub("Call +1 (555) 010-2000 or mail jane@example.com, card 4111 1111 1111 1111, ssn 123-45-6789, from 10.1.2.3");
    expect(out).not.toMatch(/555|jane|4111|6789|10\.1\.2\.3/);
    expect(m.unmask(out)).toContain("jane@example.com");
  });

  it("leaves numbers, dates and amounts in text alone", () => {
    const text = "Revenue was 1,234,567.89 on 2026-03-12 across 8,397 orders, up 12.5% from 2025.";
    expect(new Masker(key).scrub(text)).toBe(text);
  });

  it("remasks known values that reappear, such as inside an error message", () => {
    const m = new Masker(key);
    const t = m.token("name", "Ada Lovelace");
    expect(m.remask(`Could not convert string 'Ada Lovelace' to INT32`)).toBe(`Could not convert string '${t}' to INT32`);
    expect(m.remask("Adam Lovelacey visited")).toBe("Adam Lovelacey visited"); // whole values only
  });

  it("unmasks every string in a tool input", () => {
    const m = new Masker(key);
    const t = m.token("email", "o'neil@example.com");
    expect(m.unmaskInput({ sql: `email = '${t}'`, title: `Spend of ${t}`, n: 3 })).toEqual({
      sql: "email = 'o''neil@example.com'",
      title: "Spend of o'neil@example.com",
      n: 3,
    });
  });

  it("restores saved tokens", () => {
    const first = new Masker(key);
    const token = first.token("phone", "+1 555 010 3000");
    expect(new Masker(key, first.tokens).unmask(token)).toBe("+1 555 010 3000");
  });
});

describe("streamUnmasker", () => {
  it("unmasks a token split across chunks", () => {
    const m = new Masker(key);
    const t = m.token("email", "jane@example.com");
    const stream = streamUnmasker(m);
    const pieces = [`Contact ${t.slice(0, 8)}`, `${t.slice(8)} today`, "."];
    const out = pieces.map((p) => stream.push(p)).join("") + stream.flush();
    expect(out).toBe("Contact jane@example.com today.");
  });

  it("passes ordinary text through unchanged", () => {
    const stream = streamUnmasker(new Masker(key));
    const out = ["Revenue rose ", "12% in ", "March"].map((p) => stream.push(p)).join("") + stream.flush();
    expect(out).toBe("Revenue rose 12% in March");
  });
});

describe("effectiveKind", () => {
  const dataset = { pii: { version: 1, detected: { email: "email" as const, region: null } }, privacy: {} as Record<string, "mask" | "allow"> };
  it("uses detection, then the user's switch", () => {
    expect(effectiveKind(dataset, { name: "email" })).toBe("email");
    expect(effectiveKind(dataset, { name: "region" })).toBeNull();
    expect(effectiveKind({ ...dataset, privacy: { email: "allow" } }, { name: "email" })).toBeNull();
    expect(effectiveKind({ ...dataset, privacy: { region: "mask" } }, { name: "region" })).toBe("pii");
  });
});

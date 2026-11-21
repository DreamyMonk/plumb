import type { ColType, ColumnProfile, Dataset, PiiKind } from "../types";

// Pure detection rules, shared by the server and the browser.

export const PII_LABEL: Record<PiiKind, string> = {
  email: "email",
  phone: "phone number",
  name: "personal name",
  address: "address",
  postcode: "postcode",
  govid: "government ID",
  card: "card or account number",
  ip: "IP address",
  dob: "date of birth",
  pii: "personal data",
};

export const PII_KINDS = Object.keys(PII_LABEL) as PiiKind[];

interface NameRule {
  kind: PiiKind;
  pattern: RegExp;
  types: ColType[];
}

const TEXT: ColType[] = ["text"];
const TEXT_OR_NUMBER: ColType[] = ["text", "integer", "number"];

// Column names are SQL-style here: lowercase with underscores.
const NAME_RULES: NameRule[] = [
  { kind: "email", pattern: /(^|_)e_?mail(_address)?($|_)/, types: TEXT },
  { kind: "phone", pattern: /(^|_)(phone|mobile|cell|telephone|tel|fax|msisdn)(_number|_no)?$/, types: TEXT_OR_NUMBER },
  {
    kind: "name",
    pattern: /^(name|full_?name|first_?name|last_?name|middle_?name|surname|given_?name|family_?name|display_?name|user_?name|login)$|^(customer|contact|client|patient|employee|person|user|member|owner|holder|recipient|sender|buyer|seller|guest|student)_?(full_?)?name$/,
    types: TEXT,
  },
  // Before address, which would otherwise claim ip_address.
  { kind: "ip", pattern: /(^|_)(ip|ip_?address|ipv4|ipv6|client_ip|remote_addr)$/, types: TEXT },
  { kind: "address", pattern: /(^|_)(address|street|addr)(_line)?(_?\d)?$/, types: TEXT },
  { kind: "postcode", pattern: /(^|_)(zip|zip_?code|post_?code|postal_?code)$/, types: TEXT_OR_NUMBER },
  { kind: "govid", pattern: /(^|_)(ssn|social_security(_number)?|national_id|passport(_number|_no)?|tax_id|tin|nino|aadhaar|pan_number|driver_?licen[cs]e(_number)?)$/, types: TEXT_OR_NUMBER },
  { kind: "card", pattern: /(^|_)(card_?number|credit_?card|cc_?number|iban|account_?number|bank_?account)$/, types: TEXT_OR_NUMBER },
  { kind: "dob", pattern: /(^|_)(dob|date_of_birth|birth_?date|birthday)$/, types: ["date", "datetime", "text"] },
];

export function kindFromName(name: string, type: ColType): PiiKind | null {
  for (const rule of NAME_RULES) {
    if (rule.types.includes(type) && rule.pattern.test(name)) return rule.kind;
  }
  return null;
}

export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const SSN = /^\d{3}-\d{2}-\d{4}$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const PERSON = /^[A-Z][a-z]+(?:[ '-][A-Z][a-z]+){1,2}$/;
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}|^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/;

/** The standard card check digit, which random numbers pass only one time in ten. */
export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function isCard(text: string): boolean {
  const digits = text.replace(/[\s-]/g, "");
  return /^\d{13,19}$/.test(digits) && /^[\d\s-]+$/.test(text) && luhn(digits);
}

export function isPhone(text: string): boolean {
  if (DATE_LIKE.test(text) || !/^\+?[\d\s().-]+$/.test(text)) return false;
  const digits = text.replace(/\D/g, "").length;
  const separated = /[\s().-]/.test(text) || text.startsWith("+");
  return digits >= 7 && digits <= 15 && separated;
}

const share = (values: string[], test: (value: string) => boolean) => values.filter(test).length / values.length;

/** Judges a column by a sample of its values. Needs most values to agree before deciding. */
export function kindFromValues(values: string[]): PiiKind | null {
  const sample = values.map((v) => v.trim()).filter(Boolean);
  if (sample.length < 5) return null;
  if (share(sample, (v) => EMAIL.test(v) && v.length < 120) >= 0.6) return "email";
  if (share(sample, isCard) >= 0.6) return "card";
  if (share(sample, (v) => SSN.test(v)) >= 0.6) return "govid";
  if (share(sample, (v) => IPV4.test(v)) >= 0.6) return "ip";
  if (share(sample, isPhone) >= 0.6) return "phone";
  // "Ada Lovelace" style values. Many distinct ones are needed, because a handful
  // of two-word labels such as product names look the same.
  if (new Set(sample).size >= 50 && share(sample, (v) => PERSON.test(v)) >= 0.8) return "name";
  return null;
}

/** What the user's switch plus detection decide for one column. */
export function effectiveKind(dataset: Pick<Dataset, "pii" | "privacy">, column: Pick<ColumnProfile, "name">): PiiKind | null {
  const override = dataset.privacy?.[column.name];
  const detected = dataset.pii?.detected[column.name] ?? null;
  if (override === "allow") return null;
  if (override === "mask") return detected ?? "pii";
  return detected;
}

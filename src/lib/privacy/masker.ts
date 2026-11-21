import { createHmac } from "node:crypto";
import type { PiiKind } from "../types";
import { EMAIL, isCard, isPhone, PII_KINDS } from "./detect";

const TOKEN = new RegExp(`\\b(?:${PII_KINDS.join("|")})_[0-9a-f]{6,16}\\b`, "g");
const MIN_REMASK_LENGTH = 3;
const MAX_REMASK_VALUES = 5000;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Free text can hold personal data in any column, so these patterns are checked everywhere.
const EMAILS = new RegExp(EMAIL.source, "g");
const CARDS = /(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/g;
const SSNS = /(?<![\w-])\d{3}-\d{2}-\d{4}(?![\w-])/g;
const IPS = /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w.])/g;
const PHONES = /(?<![\w.+-])\+?\(?\d[\d ().-]{5,18}\d(?![\w.])/g;

/**
 * Swaps personal values for stable tokens such as email_3fa91c, and back again.
 *
 * Tokens come from a keyed hash, so a value always gets the same token on this machine and
 * the token can't be reversed without the key, which never leaves the machine. Token to
 * value pairs are kept so Claude's SQL and answers can be translated back locally.
 */
export class Masker {
  readonly tokens: Record<string, string>;
  private readonly reverse = new Map<string, string>();
  private pattern: RegExp | null = null;

  constructor(private readonly key: Buffer, saved: Record<string, string> = {}) {
    this.tokens = { ...saved };
    for (const [token, value] of Object.entries(saved)) this.reverse.set(value, token);
  }

  token(kind: PiiKind, raw: unknown): string {
    const value = String(raw);
    const existing = this.reverse.get(value);
    if (existing) return existing;
    const digest = createHmac("sha256", this.key).update(value).digest("hex");
    let length = 6;
    let token = `${kind}_${digest.slice(0, length)}`;
    while (this.tokens[token] !== undefined && this.tokens[token] !== value) token = `${kind}_${digest.slice(0, ++length)}`;
    this.tokens[token] = value;
    this.reverse.set(value, token);
    this.pattern = null;
    return token;
  }

  /** Masks personal data recognisable by its shape, wherever it appears in text. */
  scrub(text: string): string {
    return text
      .replace(EMAILS, (m) => this.token("email", m))
      .replace(SSNS, (m) => this.token("govid", m))
      .replace(CARDS, (m) => (isCard(m) ? this.token("card", m) : m))
      .replace(IPS, (m) => this.token("ip", m))
      .replace(PHONES, (m) => (isPhone(m.trim()) ? this.token("phone", m) : m));
  }

  /**
   * The safety net for any text bound for Claude: values already known to be personal are
   * swapped wherever they appear (for example inside a database error that quotes them),
   * then the shape-based patterns run.
   */
  remask(text: string): string {
    const pattern = this.knownValues();
    const swapped = pattern ? text.replace(pattern, (m) => this.reverse.get(m) ?? m) : text;
    return this.scrub(swapped);
  }

  private knownValues(): RegExp | null {
    if (this.pattern) return this.pattern;
    const values = [...this.reverse.keys()]
      .filter((v) => v.length >= MIN_REMASK_LENGTH)
      .slice(-MAX_REMASK_VALUES)
      .sort((a, b) => b.length - a.length);
    if (values.length === 0) return null;
    this.pattern = new RegExp(`(?<![\\w@])(?:${values.map(escapeRegExp).join("|")})(?![\\w@])`, "g");
    return this.pattern;
  }

  unmask(text: string): string {
    return text.replace(TOKEN, (t) => this.tokens[t] ?? t);
  }

  /** For SQL: real values go inside string literals, so their quotes are doubled. */
  unmaskSql(sql: string): string {
    return sql.replace(TOKEN, (t) => (this.tokens[t] === undefined ? t : this.tokens[t].replace(/'/g, "''")));
  }

  /** Unmasks every string in a tool input. SQL fields get literal-safe values. */
  unmaskInput(value: unknown, key = ""): unknown {
    if (typeof value === "string") return key === "sql" || key === "where" ? this.unmaskSql(value) : this.unmask(value);
    if (Array.isArray(value)) return value.map((item) => this.unmaskInput(item, key));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.unmaskInput(v, k)]));
    }
    return value;
  }
}

/**
 * Unmasks streamed text. A token can arrive split across two chunks ("email_3f" then
 * "a91c"), so a trailing word is held back until the next chunk shows where it ends.
 */
export function streamUnmasker(masker: Masker) {
  let pending = "";
  return {
    push(delta: string): string {
      const text = pending + delta;
      const tail = text.match(/[A-Za-z0-9_]*$/)?.[0] ?? "";
      if (tail.length > 0 && tail.length <= 24 && tail.length < text.length + 1) {
        pending = tail;
        return masker.unmask(text.slice(0, text.length - tail.length));
      }
      pending = "";
      return masker.unmask(text);
    },
    flush(): string {
      const rest = masker.unmask(pending);
      pending = "";
      return rest;
    },
  };
}

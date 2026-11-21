import { describe, expect, it } from "vitest";
import { createSession, passwordMatches, safeNext, SESSION_DAYS, verifySession } from "../src/lib/auth/session";

const password = "correct horse battery";

describe("sessions", () => {
  it("accepts a session it signed", async () => {
    expect(await verifySession(await createSession(password), password)).toBe(true);
  });

  it("rejects a session after the password changes", async () => {
    expect(await verifySession(await createSession(password), "a new password")).toBe(false);
  });

  it("rejects a tampered expiry", async () => {
    const [, signature] = (await createSession(password)).split(".");
    expect(await verifySession(`${Date.now() + 10 ** 12}.${signature}`, password)).toBe(false);
  });

  it("rejects a forged signature", async () => {
    const [expires] = (await createSession(password)).split(".");
    expect(await verifySession(`${expires}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, password)).toBe(false);
  });

  it("expires", async () => {
    const issued = Date.now() - (SESSION_DAYS + 1) * 86_400_000;
    expect(await verifySession(await createSession(password, issued), password)).toBe(false);
  });

  it.each([undefined, "", "garbage", "123", ".", "abc.def", "123.!!!"])("rejects %j", async (token) => {
    expect(await verifySession(token, password)).toBe(false);
  });
});

describe("passwordMatches", () => {
  it("matches only the exact password", async () => {
    expect(await passwordMatches(password, password)).toBe(true);
    expect(await passwordMatches("correct horse batter", password)).toBe(false);
    expect(await passwordMatches("", password)).toBe(false);
    expect(await passwordMatches(`${password} `, password)).toBe(false);
  });
});

describe("safeNext", () => {
  it("keeps paths on this site", () => {
    expect(safeNext("/chat?id=1")).toBe("/chat?id=1");
  });

  it.each(["https://evil.example", "//evil.example", "/\\evil.example", "/login", "", null, "javascript:alert(1)"])("sends %j home instead", (next) => {
    expect(safeNext(next)).toBe("/");
  });
});

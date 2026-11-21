import { NextResponse } from "next/server";
import { z } from "zod";
import { createSession, MIN_PASSWORD_LENGTH, passwordMatches, SESSION_COOKIE, SESSION_DAYS } from "@/lib/auth/session";

const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60_000;
const FAILURE_DELAY_MS = 400;

// One failure count for the whole app. Plumb has no proxy in front of it, so there's no
// client address to trust: a forwarded-for header can be set to anything, and a per-client
// count keyed on it could be dodged by changing it on every guess.
const globalForLogin = globalThis as unknown as { __plumbLogin?: { failures: number; lockedUntil: number } };
const record = (globalForLogin.__plumbLogin ??= { failures: 0, lockedUntil: 0 });

function configuredPassword(): string | null {
  const password = process.env.PLUMB_PASSWORD;
  return password && password.length >= MIN_PASSWORD_LENGTH ? password : null;
}

/** Lets the login page say whether a password still needs to be set. */
export async function GET() {
  return NextResponse.json({ configured: configuredPassword() !== null });
}

export async function POST(request: Request) {
  const password = configuredPassword();
  if (!password) {
    return NextResponse.json({ error: `Set PLUMB_PASSWORD in .env.local (at least ${MIN_PASSWORD_LENGTH} characters), then restart Plumb.` }, { status: 503 });
  }

  if (record.lockedUntil > Date.now()) {
    const wait = Math.ceil((record.lockedUntil - Date.now()) / 1000);
    return NextResponse.json({ error: `Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} minutes.` }, { status: 429, headers: { "Retry-After": String(wait) } });
  }

  const parsed = z.object({ password: z.string().max(1000) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success || !(await passwordMatches(parsed.data.password, password))) {
    record.failures += 1;
    if (record.failures >= MAX_FAILURES) {
      record.failures = 0;
      record.lockedUntil = Date.now() + LOCKOUT_MS;
    }
    // A short pause makes guessing slow even before the lockout.
    await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
    return NextResponse.json({ error: "Wrong password." }, { status: 401 });
  }

  record.failures = 0;
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, await createSession(password), {
    httpOnly: true, // page scripts can't read it
    sameSite: "lax",
    secure: new URL(request.url).protocol === "https:",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
  return response;
}

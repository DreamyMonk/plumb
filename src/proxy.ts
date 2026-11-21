import { NextResponse, type NextRequest } from "next/server";
import { MIN_PASSWORD_LENGTH, SESSION_COOKIE, verifySession } from "@/lib/auth/session";

// Three gates, in order:
// 1. Host: only local addresses, which also blocks DNS rebinding.
// 2. Origin: API calls must come from Plumb's own pages, which blocks cross-site requests.
// 3. Password: every page and route needs a valid session, except the login itself.
// Stream ingest is the one exception to all three. Pipelines can't log in, so each
// request carries its stream's token instead, and the route checks it.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const PUBLIC_PATHS = new Set(["/login", "/api/auth/login"]);

const deny = (status: number, error: string) => NextResponse.json({ error }, { status });

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/api/ingest/")) return NextResponse.next();

  const host = request.headers.get("host") ?? "";
  if (!LOCAL_HOST.test(host)) return deny(403, "Plumb only accepts local connections.");

  const isApi = pathname.startsWith("/api/");
  const origin = request.headers.get("origin");
  if (isApi && origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      // Falls through to the rejection below.
    }
    if (originHost !== host) return deny(403, "Cross-origin requests are not allowed.");
  }

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const password = process.env.PLUMB_PASSWORD;
  const configured = Boolean(password && password.length >= MIN_PASSWORD_LENGTH);
  if (configured && (await verifySession(request.cookies.get(SESSION_COOKIE)?.value, password!))) {
    return NextResponse.next();
  }
  // With no password set, nothing opens: an unset password must never mean "no lock".
  if (isApi) return deny(401, configured ? "Log in to use Plumb." : "Set PLUMB_PASSWORD in .env.local, then restart Plumb.");
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

// Everything except Next's own static files, which hold no data.
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };

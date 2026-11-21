import { NextResponse, type NextRequest } from "next/server";

// Plumb has no login: it is a single-user app on 127.0.0.1. These checks stop a web
// page open in the same browser from reaching the API, either with a cross-site form
// post (Origin) or by pointing its own domain at localhost (Host).
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function proxy(request: NextRequest) {
  // Pipelines reach this one path from other machines. Each request needs a stream token,
  // which the route checks. Every other route stays local-only.
  if (request.nextUrl.pathname.startsWith("/api/ingest/")) return NextResponse.next();

  const host = request.headers.get("host") ?? "";
  if (!LOCAL_HOST.test(host)) {
    return NextResponse.json({ error: "Plumb only accepts local connections." }, { status: 403 });
  }
  const origin = request.headers.get("origin");
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      // Falls through to the rejection below.
    }
    if (originHost !== host) {
      return NextResponse.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
    }
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };

import { createHash, timingSafeEqual } from "node:crypto";
import { json } from "@/lib/api";
import { streams } from "@/lib/store";
import { ingestRecords } from "@/lib/streams/append";
import { parsePayload, type StreamRecord } from "@/lib/streams/payload";

type Context = { params: Promise<{ id: string }> };

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_RECORDS = 100_000;

function presentedToken(request: Request): string | null {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  // Webhook senders like dbt Cloud can't set headers, so the URL form is accepted too.
  return bearer ?? request.headers.get("x-plumb-token") ?? new URL(request.url).searchParams.get("token");
}

function tokenMatches(token: string | null, expectedHash: string): boolean {
  if (!token) return false;
  const actual = createHash("sha256").update(token).digest();
  return timingSafeEqual(actual, Buffer.from(expectedHash, "hex"));
}

const UNAUTHORIZED = "Missing or invalid stream token.";

export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  const stream = await streams.get(id).catch(() => null);
  // The same answer for an unknown stream and a bad token, so ids can't be probed.
  if (!stream || !tokenMatches(presentedToken(request), stream.tokenHash)) return json({ error: UNAUTHORIZED }, 401);

  if (stream.status === "paused") {
    return new Response(JSON.stringify({ error: "This stream is paused." }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Retry-After": "30" },
    });
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES) return json({ error: "The body is over the 50 MB limit." }, 413);

  let records: StreamRecord[];
  try {
    records = parsePayload(request.headers.get("content-type") ?? "", await request.text());
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Could not read the body." }, 400);
  }
  if (records.length === 0) return json({ error: "The body had no records." }, 400);
  if (records.length > MAX_RECORDS) return json({ error: `Send at most ${MAX_RECORDS} records per request.` }, 413);

  // The reply comes only after the write, so a sender that sees an error can safely retry.
  try {
    return json(await ingestRecords(id, records));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Could not write these records." }, 500);
  }
}

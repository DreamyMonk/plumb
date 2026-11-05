import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { aiErrorMessage } from "./ai/client";

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status });

type Handler<C> = (request: Request, context: C) => Promise<Response>;

export function route<C = unknown>(handler: Handler<C>): Handler<C> {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return json({ error: "That request was not valid." }, 400);
      }
      return json({ error: aiErrorMessage(error) }, 400);
    }
  };
}

/** Streams newline-delimited JSON. Client disconnects abort `signal`. */
export function ndjson<E>(request: Request, run: (emit: (event: E) => void, signal: AbortSignal) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const emit = (event: E) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false;
        }
      };
      try {
        await run(emit, request.signal);
      } finally {
        open = false;
        try {
          controller.close();
        } catch {
          // Already closed by a disconnect.
        }
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform" },
  });
}

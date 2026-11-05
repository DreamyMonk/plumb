"use client";

import { useState } from "react";
import { readStream } from "@/lib/client";

type Event = { type: "status"; message: string } | { type: "done"; id: string } | { type: "error"; message: string };

export function useGenerator() {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = async (body: { tables: string[]; instruction?: string; replaceId?: string }): Promise<string | null> => {
    setStatus("Starting");
    setError(null);
    let id: string | null = null;
    try {
      const response = await fetch("/api/dashboards/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      await readStream<Event>(response, (event) => {
        if (event.type === "status") setStatus(event.message);
        if (event.type === "done") id = event.id;
        if (event.type === "error") setError(event.message);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStatus(null);
    }
    return id;
  };
  return { status, error, generate, clearError: () => setError(null) };
}

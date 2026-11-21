"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveUpdate } from "./types";

export async function api<T>(url: string, init?: RequestInit & { body?: BodyInit | null }): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error ?? `Request failed (${response.status})`);
  return data as T;
}

export const post = <T,>(url: string, body?: unknown, signal?: AbortSignal) =>
  api<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}), signal });

export function useApi<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    if (!url) return;
    const ticket = ++latest.current;
    setLoading(true);
    try {
      const result = await api<T>(url);
      if (ticket === latest.current) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (ticket === latest.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, setData, error, loading, refresh };
}

/** Reads a newline-delimited JSON response, calling back per event. */
export async function readStream<E>(response: Response, onEvent: (event: E) => void): Promise<void> {
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error ?? `Request failed (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line) as E);
  }
}

/** Datasets changed: tells the sidebar to reload. */
export const notifyDatasets = () => window.dispatchEvent(new Event("datasets-changed"));

/** Calls back when a stream writes new data. EventSource reconnects by itself if dropped. */
export function useLiveUpdates(onUpdate: (update: LiveUpdate) => void): void {
  const latest = useRef(onUpdate);
  latest.current = onUpdate;
  useEffect(() => {
    const source = new EventSource("/api/streams/live");
    source.onmessage = (message) => latest.current(JSON.parse(message.data) as LiveUpdate);
    return () => source.close();
  }, []);
}

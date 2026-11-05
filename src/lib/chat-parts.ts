import type { ChatEvent, UiPart } from "./types";

/** Folds a stream event into message parts. The server and the browser share this. */
export function applyChatEvent(parts: UiPart[], event: ChatEvent): UiPart[] {
  const last = parts[parts.length - 1];
  switch (event.type) {
    case "text":
      return last?.type === "text"
        ? [...parts.slice(0, -1), { type: "text", text: last.text + event.delta }]
        : [...parts, { type: "text", text: event.delta }];
    case "progress":
      if (!event.delta) return parts;
      return last?.type === "progress"
        ? [...parts.slice(0, -1), { type: "progress", text: last.text + event.delta }]
        : [...parts, { type: "progress", text: event.delta }];
    case "tool_start":
      return [...parts, { type: "tool", call: { id: event.id, name: event.name, label: event.label, status: "running" } }];
    case "tool_end":
      return parts.map((part) =>
        part.type === "tool" && part.call.id === event.id
          ? { type: "tool", call: { ...part.call, status: event.status, detail: event.detail, sql: event.sql, artifact: event.artifact } }
          : part,
      );
    default:
      return parts;
  }
}

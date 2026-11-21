import "server-only";
import { events } from "./store";
import type { EventMark, EventNote } from "./types";

const byDate = (a: EventNote, b: EventNote) => a.date.localeCompare(b.date);

export async function eventsFor(table: string | null, from: string, to: string): Promise<EventNote[]> {
  const all = await events.list();
  return all
    .filter((event) => (!event.table || event.table === table) && event.date >= from.slice(0, 10) && event.date <= to.slice(0, 10))
    .sort(byDate);
}

/** Routine pipeline runs stay on the Timeline. Chart markers keep to events worth a line. */
export function toMarks(list: EventNote[]): EventMark[] {
  return list.filter((event) => event.category !== "pipeline").map(({ date, title, category }) => ({ date, title, category }));
}

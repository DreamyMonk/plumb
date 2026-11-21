import { EventEmitter } from "node:events";
import type { LiveUpdate } from "../types";

// One emitter per process, kept on globalThis because each route is bundled separately.
const globalForBus = globalThis as unknown as { __plumbBus?: EventEmitter };
const bus = (globalForBus.__plumbBus ??= new EventEmitter().setMaxListeners(0));

export const publishUpdate = (update: LiveUpdate) => bus.emit("update", update);

export function subscribeUpdates(listener: (update: LiveUpdate) => void): () => void {
  bus.on("update", listener);
  return () => bus.off("update", listener);
}

import "server-only";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./db";
import type { Dashboard, Dataset, EventNote, ModelSummary, StreamInfo, UiMessage } from "./types";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";

export const newId = () => randomUUID().slice(0, 8);

/** Rejects anything that could escape the collection folder. */
function safeName(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) throw new Error("Invalid id");
  return id;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${newId()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value));
  // Windows refuses to replace a file while something is reading it, so retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(temp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= 6 || !["EPERM", "EBUSY", "EACCES"].includes(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function collection<T extends { id: string }>(name: string) {
  const dir = path.join(DATA_DIR, name);
  const file = (id: string) => path.join(dir, `${safeName(id)}.json`);
  return {
    get: async (id: string) => readJson<T>(file(id)),
    save: (item: T) => writeJson(file(item.id), item),
    remove: (id: string) => fs.rm(file(id), { force: true }),
    async list(): Promise<T[]> {
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        return [];
      }
      const items = await Promise.all(
        names.filter((n) => n.endsWith(".json")).map((n) => readJson<T>(path.join(dir, n))),
      );
      return items.filter((item) => item !== null) as T[];
    },
  };
}

export interface StoredChat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** The exact API transcript. Append-only: thinking blocks must be replayed unchanged. */
  api: BetaMessageParam[];
  ui: UiMessage[];
  contextHash?: string;
  /** Identifies the system prompt and tools this transcript was produced with. */
  transcriptVersion?: string;
}

export interface StoredModel {
  id: string;
  summary: ModelSummary;
  artifact: unknown;
}

export interface StoredStream extends StreamInfo {
  tokenHash: string;
}

export const datasets = collection<Dataset>("datasets");
export const events = collection<EventNote>("events");
export const streams = collection<StoredStream>("streams");
export const dashboards = collection<Dashboard>("dashboards");
export const chats = collection<StoredChat>("chats");
export const models = collection<StoredModel>("models");

import { z } from "zod";
import { json, route } from "@/lib/api";
import { ingestTable } from "@/lib/ingest/ingest";
import { DEFAULT_ROW_LIMIT, describeConnection, listRemoteTables, readRemoteTable } from "@/lib/sources/connectors";
import type { Dataset } from "@/lib/types";

const table = z.object({ schema: z.string().optional(), name: z.string(), rows: z.number().nullable(), kind: z.enum(["table", "view"]) });

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), kind: z.enum(["postgres", "mysql"]), url: z.string() }),
  z.object({ action: z.literal("import"), kind: z.enum(["postgres", "mysql"]), url: z.string(), tables: z.array(table), limit: z.number().int().positive().optional() }),
]);

// The connection string is used for this request only. It is never written to disk.
export const POST = route(async (request) => {
  const input = body.parse(await request.json());
  if (input.action === "list") {
    return json({ tables: await listRemoteTables(input.kind, input.url) });
  }
  const created: Dataset[] = [];
  const errors: { file: string; message: string }[] = [];
  for (const remote of input.tables) {
    try {
      const parsed = await readRemoteTable(input.kind, input.url, remote, input.limit ?? DEFAULT_ROW_LIMIT);
      created.push(await ingestTable(parsed, { kind: input.kind, name: `${describeConnection(input.url)} / ${remote.name}` }));
    } catch (error) {
      errors.push({ file: remote.name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return json({ datasets: created, errors });
});

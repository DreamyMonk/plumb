import { json, route } from "@/lib/api";
import { ident, withConnection } from "@/lib/db";
import { datasets } from "@/lib/store";
import type { Row } from "@/lib/types";

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>(async (request, { params }) => {
  const { id } = await params;
  const dataset = await datasets.get(id);
  if (!dataset) return json({ error: "Dataset not found." }, 404);

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 500);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
  const sort = url.searchParams.get("sort");
  const direction = url.searchParams.get("dir") === "desc" ? "DESC" : "ASC";
  const search = url.searchParams.get("q")?.trim();

  // Sort columns are checked against the catalog; the search term is a bound parameter.
  const order = sort && dataset.columns.some((c) => c.name === sort) ? `ORDER BY ${ident(sort)} ${direction} NULLS LAST` : "";
  const searchable = dataset.columns.filter((c) => c.type === "text").map((c) => `${ident(c.name)} ILIKE $1`);
  const where = search && searchable.length ? `WHERE ${searchable.join(" OR ")}` : "";
  const values = where ? [`%${search}%`] : [];
  const table = ident(id);

  const result = await withConnection(async (conn) => {
    const rows = await conn.runAndReadAll(`SELECT * FROM ${table} ${where} ${order} LIMIT ${limit} OFFSET ${offset}`, values);
    const count = await conn.runAndReadAll(`SELECT COUNT(*) AS n FROM ${table} ${where}`, values);
    return { rows: rows.getRowObjectsJson() as Row[], total: Number((count.getRowObjectsJson()[0] as Row).n) };
  });
  return json(result);
});

import * as XLSX from "xlsx";
import { json, route } from "@/lib/api";
import { ident, query } from "@/lib/db";
import { csvCell } from "@/lib/format";
import { datasets } from "@/lib/store";

type Context = { params: Promise<{ id: string }> };

const PAGE = 50_000;
const EXCEL_MAX_ROWS = 1_048_575;

export const GET = route<Context>(async (request, { params }) => {
  const { id } = await params;
  const dataset = await datasets.get(id);
  if (!dataset) return json({ error: "Dataset not found." }, 404);
  const format = new URL(request.url).searchParams.get("format") === "xlsx" ? "xlsx" : "csv";
  const names = dataset.columns.map((c) => c.name);

  if (format === "xlsx") {
    if (dataset.rowCount > EXCEL_MAX_ROWS) return json({ error: "This table is too large for Excel. Export it as CSV." }, 400);
    const rows = await query(`SELECT * FROM ${ident(id)}`);
    const sheet = XLSX.utils.json_to_sheet(rows, { header: names });
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Data");
    const buffer: Buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${id}.xlsx"`,
      },
    });
  }

  const encoder = new TextEncoder();
  let offset = 0;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`${names.map(csvCell).join(",")}\r\n`));
    },
    async pull(controller) {
      const rows = await query(`SELECT * FROM ${ident(id)} LIMIT ${PAGE} OFFSET ${offset}`);
      if (rows.length === 0) {
        controller.close();
        return;
      }
      offset += rows.length;
      const text = rows.map((row) => names.map((n) => csvCell(row[n])).join(",")).join("\r\n");
      controller.enqueue(encoder.encode(`${text}\r\n`));
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${id}.csv"` },
  });
});

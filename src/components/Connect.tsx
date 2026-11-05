"use client";

import { Database, FileUp, Link2, Upload } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { api, notifyDatasets, post } from "@/lib/client";
import type { Dataset } from "@/lib/types";
import { Button, Card, Field, inputClass, Note, Select, Tabs } from "./ui";

interface ImportResult {
  datasets: Dataset[];
  errors: { file: string; message: string }[];
}

interface RemoteTable {
  schema?: string;
  name: string;
  rows: number | null;
  kind: "table" | "view";
}

type Mode = "file" | "database" | "link";

const ACCEPT = ".csv,.tsv,.txt,.xlsx,.xlsm,.xlsb,.xls,.ods,.json,.jsonl,.ndjson,.sqlite,.sqlite3,.db";

export function Connect({ onDone }: { onDone: (result: ImportResult) => void }) {
  const [mode, setMode] = useState<Mode>("file");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const [kind, setKind] = useState("postgres");
  const [connection, setConnection] = useState("");
  const [tables, setTables] = useState<RemoteTable[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [link, setLink] = useState("");

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = (result: ImportResult) => {
    notifyDatasets();
    onDone(result);
  };

  const upload = (files: FileList | File[]) =>
    run(async () => {
      const form = new FormData();
      for (const file of Array.from(files)) form.append("files", file);
      finish(await api<ImportResult>("/api/upload", { method: "POST", body: form }));
      if (input.current) input.current.value = "";
    });

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) void upload(event.dataTransfer.files);
  };

  const keyOf = (table: RemoteTable) => `${table.schema ?? ""}.${table.name}`;

  const listTables = () =>
    run(async () => {
      const result = await post<{ tables: RemoteTable[] }>("/api/sources/db", { action: "list", kind, url: connection });
      setTables(result.tables);
      setPicked(new Set());
    });

  const importTables = () =>
    run(async () => {
      const chosen = (tables ?? []).filter((table) => picked.has(keyOf(table)));
      finish(await post<ImportResult>("/api/sources/db", { action: "import", kind, url: connection, tables: chosen }));
      setConnection("");
      setTables(null);
    });

  const importLink = () =>
    run(async () => {
      finish(await post<ImportResult>("/api/sources/url", { url: link }));
      setLink("");
    });

  return (
    <Card className="p-5">
      <Tabs<Mode>
        value={mode}
        onChange={(next) => {
          setMode(next);
          setError(null);
        }}
        tabs={[
          { id: "file", label: "Files" },
          { id: "database", label: "Database" },
          { id: "link", label: "Link or API" },
        ]}
      />
      {error ? (
        <div className="mb-3">
          <Note tone="bad" onClose={() => setError(null)}>{error}</Note>
        </div>
      ) : null}

      {mode === "file" ? (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${dragging ? "border-accent bg-accent-soft" : "border-line"}`}
        >
          <FileUp size={22} className="mx-auto text-ink-3" aria-hidden />
          <p className="mt-2 font-medium">Drop as many files as you like</p>
          <p className="text-ink-2 text-[13px] mt-0.5">CSV, Excel (every sheet), JSON or SQLite, up to 200 MB each. They are cleaned automatically.</p>
          <input ref={input} type="file" multiple accept={ACCEPT} hidden aria-label="Choose files" onChange={(event) => event.target.files && void upload(event.target.files)} />
          <Button className="mt-4" variant="primary" busy={busy} onClick={() => input.current?.click()}>
            <Upload size={14} /> {busy ? "Cleaning…" : "Choose files"}
          </Button>
        </div>
      ) : null}

      {mode === "database" ? (
        <div className="space-y-3">
          <div className="grid sm:grid-cols-[140px_1fr] gap-3">
            <Field label="Type">
              <Select
                value={kind}
                onChange={(value) => {
                  setKind(value);
                  setTables(null);
                }}
                options={[
                  { value: "postgres", label: "PostgreSQL" },
                  { value: "mysql", label: "MySQL" },
                ]}
              />
            </Field>
            <Field label="Connection string" hint="Read-only session. Used for this import, never saved. Use a read-only account where you can.">
              <input
                className={`${inputClass} font-mono text-[12.5px]`}
                type="password"
                autoComplete="off"
                value={connection}
                onChange={(event) => setConnection(event.target.value)}
                placeholder={kind === "postgres" ? "postgres://user:password@host:5432/db" : "mysql://user:password@host:3306/db"}
              />
            </Field>
          </div>
          <Button variant="primary" busy={busy && !tables} disabled={!connection.trim()} onClick={() => void listTables()}>
            <Database size={14} /> Connect
          </Button>
          {tables ? (
            tables.length === 0 ? (
              <p className="text-ink-2">No tables found.</p>
            ) : (
              <div>
                <p className="text-[12.5px] font-medium text-ink-2 mb-1">Choose tables to import a snapshot of (up to 500,000 rows each)</p>
                <div className="max-h-56 overflow-y-auto rounded-lg border border-line divide-y divide-line">
                  {tables.map((table) => (
                    <label key={keyOf(table)} className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-surface-2">
                      <input
                        type="checkbox"
                        checked={picked.has(keyOf(table))}
                        onChange={(event) => {
                          const next = new Set(picked);
                          if (event.target.checked) next.add(keyOf(table));
                          else next.delete(keyOf(table));
                          setPicked(next);
                        }}
                      />
                      <span className="truncate">{table.schema && table.schema !== "public" ? `${table.schema}.` : ""}{table.name}</span>
                      <span className="ml-auto text-[12px] text-ink-3 tnum">{table.kind === "view" ? "view" : table.rows === null ? "" : `~${table.rows.toLocaleString()} rows`}</span>
                    </label>
                  ))}
                </div>
                <Button className="mt-3" variant="primary" busy={busy} disabled={picked.size === 0} onClick={() => void importTables()}>
                  Import {picked.size || ""} {picked.size === 1 ? "table" : "tables"}
                </Button>
              </div>
            )
          ) : null}
        </div>
      ) : null}

      {mode === "link" ? (
        <div className="space-y-3">
          <Field label="URL" hint="A direct link to a CSV, Excel or JSON file, a JSON API, or a Google Sheet shared with “anyone with the link”.">
            <input className={inputClass} value={link} onChange={(event) => setLink(event.target.value)} placeholder="https://example.com/data.csv" />
          </Field>
          <Button variant="primary" busy={busy} disabled={!link.trim()} onClick={() => void importLink()}>
            <Link2 size={14} /> Import
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

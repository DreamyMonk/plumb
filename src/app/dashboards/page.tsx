"use client";

import { LayoutDashboard, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, Card, Empty, Field, inputClass, Note, PageHeader, Spinner } from "@/components/ui";
import { useGenerator } from "@/components/useGenerator";
import { useApi } from "@/lib/client";
import { timeAgo } from "@/lib/format";
import type { Dashboard, Dataset } from "@/lib/types";

export default function DashboardsPage() {
  const router = useRouter();
  const { data: boards, error: loadError } = useApi<Dashboard[]>("/api/dashboards");
  const { data: datasets } = useApi<Dataset[]>("/api/datasets");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [instruction, setInstruction] = useState("");
  const { status, error, generate, clearError } = useGenerator();

  useEffect(() => {
    if (!datasets?.length) return;
    const wanted = new URLSearchParams(window.location.search).get("table");
    setPicked(new Set([wanted && datasets.some((d) => d.id === wanted) ? wanted : datasets[0].id]));
  }, [datasets]);

  const run = async () => {
    const id = await generate({ tables: [...picked], instruction: instruction || undefined });
    if (id) router.push(`/dashboards/${id}`);
  };

  return (
    <div className="max-w-5xl mx-auto px-4 md:px-8 py-8">
      <PageHeader title="Dashboards" subtitle="Claude picks the measures and charts from your data, runs every query, then writes insights from the real results." />
      {loadError ? <Note tone="bad">{loadError}</Note> : null}
      {!datasets ? <Spinner /> : datasets.length === 0 ? (
        <Card><Empty title="No data yet" action={<Link href="/"><Button variant="primary">Add data</Button></Link>}>Add a table to build a dashboard from it.</Empty></Card>
      ) : (
        <Card className="p-5 mb-8">
          <p className="text-[12.5px] font-medium text-ink-2 mb-1.5">Tables to use</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mb-4">
            {datasets.map((dataset) => (
              <label key={dataset.id} className="flex items-center gap-1.5 cursor-pointer text-[13.5px]">
                <input
                  type="checkbox"
                  checked={picked.has(dataset.id)}
                  onChange={(event) => {
                    const next = new Set(picked);
                    if (event.target.checked) next.add(dataset.id);
                    else next.delete(dataset.id);
                    setPicked(next);
                  }}
                />
                {dataset.id}
              </label>
            ))}
          </div>
          <Field label="Focus (optional)">
            <input className={inputClass} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="For example: a weekly view for the sales team, focused on returns" />
          </Field>
          <div className="mt-4 flex items-center gap-3">
            <Button variant="primary" busy={Boolean(status)} disabled={picked.size === 0} onClick={() => void run()}>
              <Sparkles size={14} /> Generate dashboard
            </Button>
            {status ? <span className="text-ink-2 pulse-dot">{status}…</span> : null}
          </div>
          {error ? <div className="mt-3"><Note tone="bad" onClose={clearError}>{error}</Note></div> : null}
        </Card>
      )}
      {boards?.length ? (
        <>
          <h2 className="font-semibold mb-3">Saved</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {boards.map((board) => (
              <Link key={board.id} href={`/dashboards/${board.id}`}>
                <Card className="p-4 h-full hover:border-ink-3 transition-colors">
                  <p className="font-semibold flex items-center gap-1.5"><LayoutDashboard size={14} className="text-ink-3 shrink-0" aria-hidden /><span className="truncate">{board.title}</span></p>
                  {board.summary ? <p className="text-[12.5px] text-ink-2 mt-1 line-clamp-2">{board.summary}</p> : null}
                  <p className="text-[12.5px] text-ink-3 mt-2">{board.widgets.length} widgets · {timeAgo(board.updatedAt)}</p>
                </Card>
              </Link>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

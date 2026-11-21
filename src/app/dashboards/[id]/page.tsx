"use client";

import { ChevronLeft, ChevronRight, Maximize2, Radio, RefreshCw, Sparkles, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useRef, useState } from "react";
import { ChartCard } from "@/components/charts/ChartCard";
import { Button, Empty, inputClass, Note, PageHeader, Spinner } from "@/components/ui";
import { api, useApi, useLiveUpdates } from "@/lib/client";
import type { ChartPayload, Dashboard, Widget } from "@/lib/types";
import { useGenerator } from "@/components/useGenerator";

const SPAN: Record<Widget["size"], string> = {
  s: "col-span-12 sm:col-span-6 xl:col-span-3",
  m: "col-span-12 lg:col-span-6",
  l: "col-span-12",
};
const NEXT_SIZE: Record<Widget["size"], Widget["size"]> = { s: "m", m: "l", l: "s" };
const LIVE_REFRESH_MS = 1500;

function usesTable(dashboard: Dashboard, table: string): boolean {
  return dashboard.tables.includes(table) || dashboard.widgets.some((w) => w.spec.sql?.includes(table) || w.spec.timeline?.table === table);
}

export default function DashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data, error, loading, refresh, setData } = useApi<{ dashboard: Dashboard; payloads: ChartPayload[] }>(`/api/dashboards/${id}`);
  const [instruction, setInstruction] = useState("");
  const [confirming, setConfirming] = useState(false);
  const { status, error: generateError, generate, clearError } = useGenerator();
  const [live, setLive] = useState(false);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Bursts of rows become one refresh, because every refresh re-runs each widget's query.
  useLiveUpdates((update) => {
    if (!update.table || !data || !usesTable(data.dashboard, update.table)) return;
    setLive(true);
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      void refresh();
    }, LIVE_REFRESH_MS);
  });

  if (loading && !data) return <Spinner label="Running queries" />;
  if (error || !data) return <Empty title="Dashboard not found" action={<Link href="/dashboards"><Button>All dashboards</Button></Link>}>{error}</Empty>;
  const { dashboard, payloads } = data;

  const patch = async (body: object) => {
    await api(`/api/dashboards/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  };

  const reorder = (next: Widget[], order: number[]) => {
    setData({ dashboard: { ...dashboard, widgets: next }, payloads: order.map((i) => payloads[i]) });
    void patch({ widgetOrder: next.map((w) => w.id) });
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= dashboard.widgets.length) return;
    const order = dashboard.widgets.map((_, i) => i);
    [order[index], order[target]] = [order[target], order[index]];
    reorder(order.map((i) => dashboard.widgets[i]), order);
  };

  const removeWidget = (index: number) => {
    const order = dashboard.widgets.map((_, i) => i).filter((i) => i !== index);
    reorder(order.map((i) => dashboard.widgets[i]), order);
  };

  const resize = (widget: Widget) => {
    const size = NEXT_SIZE[widget.size];
    setData({ dashboard: { ...dashboard, widgets: dashboard.widgets.map((w) => (w.id === widget.id ? { ...w, size } : w)) }, payloads });
    void patch({ sizes: { [widget.id]: size } });
  };

  const rebuild = async () => {
    const newId = await generate({ tables: dashboard.tables, instruction, replaceId: id });
    if (newId) {
      setInstruction("");
      void refresh();
    }
  };

  const removeDashboard = async () => {
    await api(`/api/dashboards/${id}`, { method: "DELETE" });
    router.push("/dashboards");
  };

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-8 py-8">
      <PageHeader
        title={dashboard.title}
        subtitle={dashboard.summary}
        actions={
          <>
            {live ? <span className="flex items-center gap-1.5 text-[12.5px] text-ink-2"><Radio size={13} className="pulse-dot text-good" aria-hidden /> Live</span> : null}
            <Button busy={loading && !live} onClick={() => void refresh()}><RefreshCw size={14} /> Refresh</Button>
            {confirming ? <Button variant="danger" onClick={() => void removeDashboard()}>Confirm delete</Button> : <Button variant="ghost" aria-label="Delete dashboard" title="Delete dashboard" onClick={() => setConfirming(true)}><Trash2 size={14} /></Button>}
          </>
        }
      />

      {dashboard.takeaways?.length ? (
        <section className="mb-5 bg-surface border border-line rounded-xl p-4">
          <h2 className="flex items-center gap-1.5 font-semibold mb-1.5"><Sparkles size={14} className="text-accent" aria-hidden /> Key takeaways</h2>
          <ul className="space-y-1 text-[13.5px] text-ink-2 list-disc pl-5">
            {dashboard.takeaways.map((takeaway) => <li key={takeaway}>{takeaway}</li>)}
          </ul>
        </section>
      ) : null}

      {dashboard.widgets.length === 0 ? (
        <Empty title="This dashboard is empty">Pin charts from Chat or Predict, or describe what you want below.</Empty>
      ) : (
        <div className="grid grid-cols-12 gap-3">
          {dashboard.widgets.map((widget, index) => (
            <div key={widget.id} className={`${SPAN[widget.size]} rise min-w-0`}>
              <ChartCard
                payload={payloads[index] ?? { spec: widget.spec, columns: [], rows: [] }}
                pinnable={false}
                actions={
                  <>
                    <Button variant="ghost" size="sm" aria-label="Move earlier" title="Move earlier" disabled={index === 0} onClick={() => move(index, -1)}><ChevronLeft size={13} /></Button>
                    <Button variant="ghost" size="sm" aria-label="Move later" title="Move later" disabled={index === dashboard.widgets.length - 1} onClick={() => move(index, 1)}><ChevronRight size={13} /></Button>
                    <Button variant="ghost" size="sm" aria-label="Change size" title="Change size" onClick={() => resize(widget)}><Maximize2 size={13} /></Button>
                    <Button variant="ghost" size="sm" aria-label="Remove from dashboard" title="Remove" onClick={() => removeWidget(index)}><X size={13} /></Button>
                  </>
                }
              />
            </div>
          ))}
        </div>
      )}

      {dashboard.tables.length > 0 ? (
        <section className="mt-6 bg-surface border border-line rounded-xl p-4">
          <label htmlFor="rebuild" className="block font-semibold">Rebuild with AI</label>
          <p className="text-[12.5px] text-ink-2 mb-2">Creates a new layout from {dashboard.tables.join(", ")}. It replaces every widget here, including pinned ones.</p>
          <div className="flex gap-2">
            <input id="rebuild" className={inputClass} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="For example: focus on returns by category" />
            <Button variant="primary" busy={Boolean(status)} onClick={() => void rebuild()}><Sparkles size={14} /> Rebuild</Button>
          </div>
          {status ? <p className="mt-2 text-ink-2 pulse-dot">{status}…</p> : null}
          {generateError ? <div className="mt-2"><Note tone="bad" onClose={clearError}>{generateError}</Note></div> : null}
        </section>
      ) : null}
    </div>
  );
}

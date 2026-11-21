"use client";

import { Check, Copy, Pause, Play, Plus, Radio, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Empty, Field, inputClass, Note, PageHeader, Select, Spinner, Tabs } from "@/components/ui";
import { api, post, useApi, useLiveUpdates } from "@/lib/client";
import { timeAgo } from "@/lib/format";
import { httpSnippets } from "@/lib/streams/snippets";
import type { KafkaSasl, StreamInfo } from "@/lib/types";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Button size="sm" variant="ghost" onClick={() => void copy()} aria-label="Copy">
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function Setup({ stream, token }: { stream: StreamInfo; token: string }) {
  const url = `${window.location.origin}/api/ingest/${stream.id}`;
  const snippets = httpSnippets(url, token, stream.target);
  const [tab, setTab] = useState(snippets[0].id);
  const current = snippets.find((s) => s.id === tab) ?? snippets[0];
  return (
    <div>
      <Tabs tabs={snippets.map((s) => ({ id: s.id, label: s.label }))} value={tab} onChange={setTab} />
      {current.note ? <p className="text-[12.5px] text-ink-2 mb-2">{current.note}</p> : null}
      <div className="relative rounded-lg bg-surface-2 p-3 overflow-x-auto">
        <div className="absolute right-1.5 top-1.5"><CopyButton text={current.code} /></div>
        <pre className="font-mono text-[12px] pr-16 whitespace-pre">{current.code}</pre>
      </div>
    </div>
  );
}

function CreateStream({ onCreated }: { onCreated: (stream: StreamInfo, token?: string) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"http" | "kafka">("http");
  const [target, setTarget] = useState<"table" | "events">("table");
  const [dedupeKey, setDedupeKey] = useState("");
  const [brokers, setBrokers] = useState("");
  const [topic, setTopic] = useState("");
  const [fromBeginning, setFromBeginning] = useState(false);
  const [ssl, setSsl] = useState(false);
  const [sasl, setSasl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const kafka = kind === "kafka"
        ? { brokers: brokers.split(",").map((b) => b.trim()).filter(Boolean), topic, fromBeginning, ssl, saslMechanism: (sasl || undefined) as KafkaSasl | undefined }
        : undefined;
      const result = await post<{ stream: StreamInfo; token?: string }>("/api/streams", { name, kind, target, dedupeKey: dedupeKey || null, kafka });
      setName("");
      setDedupeKey("");
      onCreated(result.stream, result.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5">
      <h2 className="font-semibold mb-3">New stream</h2>
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label="Name"><input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="orders live" /></Field>
        <Field label="Source">
          <Select value={kind} onChange={(v) => setKind(v as typeof kind)} options={[{ value: "http", label: "HTTP push (Airflow, dbt, Spark…)" }, { value: "kafka", label: "Kafka topic" }]} />
        </Field>
        <Field label="Send data to">
          <Select value={target} onChange={(v) => setTarget(v as typeof target)} options={[{ value: "table", label: "A live table" }, { value: "events", label: "Timeline events" }]} />
        </Field>
      </div>
      {target === "table" ? (
        <div className="mt-3 max-w-sm">
          <Field label="Unique ID field (recommended)" hint="Retries and redelivery can send a row twice. Rows with an ID already seen are skipped.">
            <input className={inputClass} value={dedupeKey} onChange={(e) => setDedupeKey(e.target.value)} placeholder="event_id" />
          </Field>
        </div>
      ) : null}
      {kind === "kafka" ? (
        <div className="mt-3 grid sm:grid-cols-2 gap-3">
          <Field label="Brokers" hint="Comma separated, like broker-1:9092,broker-2:9092"><input className={`${inputClass} font-mono text-[12.5px]`} value={brokers} onChange={(e) => setBrokers(e.target.value)} placeholder="localhost:9092" /></Field>
          <Field label="Topic"><input className={inputClass} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="orders" /></Field>
          <Field label="Authentication" hint="SASL credentials come from KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD in .env.local.">
            <Select value={sasl} onChange={setSasl} options={[{ value: "", label: "None" }, { value: "plain", label: "SASL PLAIN" }, { value: "scram-sha-256", label: "SCRAM-SHA-256" }, { value: "scram-sha-512", label: "SCRAM-SHA-512" }]} />
          </Field>
          <div className="flex flex-col gap-1.5 justify-center text-[13px]">
            <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={ssl} onChange={(e) => setSsl(e.target.checked)} /> Use TLS</label>
            <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={fromBeginning} onChange={(e) => setFromBeginning(e.target.checked)} /> Read existing messages too</label>
          </div>
        </div>
      ) : null}
      {error ? <div className="mt-3"><Note tone="bad">{error}</Note></div> : null}
      <Button className="mt-4" variant="primary" busy={busy} disabled={!name.trim() || (kind === "kafka" && (!brokers.trim() || !topic.trim()))} onClick={() => void create()}>
        <Plus size={14} /> Create stream
      </Button>
    </Card>
  );
}

function StreamRow({ stream, flash, onChanged }: { stream: StreamInfo; flash: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const setStatus = (action: "pause" | "resume") =>
    act(() => api(`/api/streams/${stream.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }));

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`size-2 rounded-full ${stream.status === "active" ? "bg-good" : stream.status === "error" ? "bg-bad" : "bg-ink-3"} ${flash ? "pulse-dot" : ""}`} aria-hidden />
        <p className="font-semibold">{stream.name}</p>
        <Badge>{stream.kind === "kafka" ? `Kafka · ${stream.kafka?.topic}` : "HTTP"}</Badge>
        <Badge>{stream.status}</Badge>
        <div className="ml-auto flex items-center gap-1">
          {stream.status === "active" ? (
            <Button size="sm" onClick={() => void setStatus("pause")}><Pause size={13} /> Pause</Button>
          ) : (
            <Button size="sm" onClick={() => void setStatus("resume")}><Play size={13} /> Resume</Button>
          )}
          {stream.kind === "http" ? <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>{open ? "Hide setup" : "Setup"}</Button> : null}
          {confirming ? (
            <Button size="sm" variant="danger" onClick={() => void act(() => api(`/api/streams/${stream.id}`, { method: "DELETE" }))}>Confirm delete</Button>
          ) : (
            <Button size="sm" variant="ghost" aria-label={`Delete ${stream.name}`} onClick={() => setConfirming(true)}><Trash2 size={13} /></Button>
          )}
        </div>
      </div>
      <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] tnum">
        <div><dt className="inline text-ink-3">Received </dt><dd className="inline font-medium">{stream.rowsReceived.toLocaleString()}</dd></div>
        {stream.rowsDuplicate ? <div><dt className="inline text-ink-3">Duplicates skipped </dt><dd className="inline">{stream.rowsDuplicate.toLocaleString()}</dd></div> : null}
        {stream.rowsRejected ? <div><dt className="inline text-ink-3">Rejected </dt><dd className="inline">{stream.rowsRejected.toLocaleString()}</dd></div> : null}
        {stream.cellsRejected ? <div><dt className="inline text-ink-3">Bad values </dt><dd className="inline">{stream.cellsRejected.toLocaleString()}</dd></div> : null}
        <div><dt className="inline text-ink-3">Last data </dt><dd className="inline">{stream.lastEventAt ? timeAgo(stream.lastEventAt) : "waiting"}</dd></div>
        {stream.table ? <div><dt className="inline text-ink-3">Table </dt><dd className="inline"><Link className="text-accent underline" href={`/data/${stream.table}`}>{stream.table}</Link></dd></div> : null}
        {stream.target === "events" ? <div><Link className="text-accent underline" href="/timeline">View on Timeline</Link></div> : null}
      </dl>
      {stream.lastError ? <div className="mt-2"><Note tone="bad">{stream.lastError}</Note></div> : null}
      {stream.lastRejected?.length ? <p className="mt-2 text-[12px] text-ink-3 break-words">Values that didn&apos;t fit, kept as blanks: {stream.lastRejected.join("  ·  ")}</p> : null}
      {error ? <div className="mt-2"><Note tone="bad">{error}</Note></div> : null}
      {open ? (
        <div className="mt-3 pt-3 border-t border-line">
          <p className="text-[12.5px] text-ink-2 mb-3">The token was shown once when you created this stream. Replace YOUR_TOKEN with it.</p>
          <Setup stream={stream} token="YOUR_TOKEN" />
        </div>
      ) : null}
    </Card>
  );
}

export default function StreamsPage() {
  const { data: streams, error: loadError, refresh } = useApi<StreamInfo[]>("/api/streams");
  const [created, setCreated] = useState<{ stream: StreamInfo; token: string } | null>(null);
  const [flash, setFlash] = useState<Record<string, boolean>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLiveUpdates((update) => {
    setFlash((current) => ({ ...current, [update.stream]: true }));
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void refresh();
    }, 800);
  });

  useEffect(() => {
    // "Last data" ages while a page sits open, so re-read it now and then.
    const interval = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <div className="max-w-4xl mx-auto px-4 md:px-8 py-8">
      <PageHeader title="Streams" subtitle="Send live data from your pipelines. Rows land in a table and update open dashboards, and pipeline events land on the Timeline." />
      <div className="space-y-4">
        {loadError ? <Note tone="bad">{loadError}</Note> : null}
        <CreateStream
          onCreated={(stream, token) => {
            if (token) setCreated({ stream, token });
            void refresh();
          }}
        />
        {created ? (
          <Card className="p-5 rise">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">Connect {created.stream.name}</h2>
                <p className="text-[12.5px] text-warn mt-0.5">Copy this token now. It won&apos;t be shown again.</p>
              </div>
              <CopyButton text={created.token} />
            </div>
            <p className="font-mono text-[12px] bg-surface-2 rounded-lg px-3 py-2 my-3 break-all">{created.token}</p>
            <Setup stream={created.stream} token={created.token} />
          </Card>
        ) : null}
        {!streams && !loadError ? <Spinner /> : null}
        {streams?.length === 0 ? (
          <Card><Empty title="No streams yet">Create one above, then send it a record to see it arrive here.</Empty></Card>
        ) : null}
        {streams?.length ? <h2 className="font-semibold pt-2 flex items-center gap-1.5"><Radio size={14} className="text-ink-3" aria-hidden /> Your streams</h2> : null}
        {streams?.map((stream) => <StreamRow key={stream.id} stream={stream} flash={Boolean(flash[stream.id])} onChanged={() => void refresh()} />)}
      </div>
    </div>
  );
}

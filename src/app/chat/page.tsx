"use client";

import { ArrowUp, Check, ChevronRight, Loader2, Plus, Square, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChartCard } from "@/components/charts/ChartCard";
import { ResultTable } from "@/components/charts/ResultTable";
import { ModelResult, PredictionOutput, WhatIf } from "@/components/ModelCard";
import { Button, Empty, Note } from "@/components/ui";
import { applyChatEvent } from "@/lib/chat-parts";
import { api, post, readStream, useApi } from "@/lib/client";
import type { ChatEvent, ChatSummary, Dataset, ToolArtifact, UiMessage, UiPart, UiToolCall } from "@/lib/types";

function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-chat">
      {/* Images are off: a data-derived image URL would send table contents to a remote server. */}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        disallowedElements={["img"]}
        unwrapDisallowed
        components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function Artifact({ artifact }: { artifact: ToolArtifact }) {
  switch (artifact.kind) {
    case "chart":
      return <div className="my-2"><ChartCard payload={artifact.payload} height={artifact.payload.spec.type === "forecast" ? 280 : 240} /></div>;
    case "table":
      return <div className="my-2"><ResultTable columns={artifact.data.columns} rows={artifact.data.rows} /></div>;
    case "model":
      return (
        <div className="my-2 space-y-3">
          <div className="bg-surface border border-line rounded-xl p-4"><ModelResult model={artifact.model} /></div>
          <WhatIf key={artifact.model.id} model={artifact.model} />
        </div>
      );
    case "prediction":
      return (
        <div className="my-2 bg-surface border border-line rounded-xl p-4 grid sm:grid-cols-2 gap-4">
          {artifact.results.map((result, index) => <PredictionOutput key={index} result={result} target={artifact.target} />)}
        </div>
      );
  }
}

function ToolStep({ call }: { call: UiToolCall }) {
  const [open, setOpen] = useState(false);
  const icon = call.status === "running" ? <Loader2 size={13} className="animate-spin" /> : call.status === "error" ? <X size={13} className="text-bad" /> : <Check size={13} className="text-good" />;
  const expandable = Boolean(call.sql || (call.status === "error" && call.detail));
  return (
    <div className="my-1">
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen(!open)}
        aria-expanded={expandable ? open : undefined}
        className={`flex items-center gap-1.5 text-[12.5px] text-ink-3 max-w-full ${expandable ? "cursor-pointer hover:text-ink" : ""}`}
      >
        {icon}
        <span className="truncate">{call.label}</span>
        {call.detail && call.status !== "error" ? <span className="shrink-0">· {call.detail}</span> : null}
        {call.status === "error" ? <span className="shrink-0">· failed</span> : null}
        {expandable ? <ChevronRight size={12} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden /> : null}
      </button>
      {open ? (
        <div className="mt-1 mb-2 ml-5 rounded-lg bg-surface-2 p-2.5 text-[12px] overflow-x-auto">
          {call.status === "error" ? <p className="text-bad mb-1">{call.detail}</p> : null}
          {call.sql ? <pre className="font-mono whitespace-pre-wrap">{call.sql}</pre> : null}
        </div>
      ) : null}
      {call.artifact ? <Artifact artifact={call.artifact} /> : null}
    </div>
  );
}

function Part({ part }: { part: UiPart }) {
  if (part.type === "text") return <Markdown text={part.text} />;
  if (part.type === "progress") return <p className="text-[12.5px] text-ink-3 my-1">{part.text}</p>;
  return <ToolStep call={part.call} />;
}

function Message({ message, live }: { message: UiMessage; live: boolean }) {
  if (message.role === "user") {
    const text = message.parts.find((part) => part.type === "text");
    return (
      <div className="flex justify-end rise">
        <p className="bg-accent-soft rounded-2xl rounded-br-md px-3.5 py-2 max-w-[85%] whitespace-pre-wrap break-words">{text?.type === "text" ? text.text : ""}</p>
      </div>
    );
  }
  return (
    <div className="min-w-0">
      {message.parts.map((part, index) => <Part key={index} part={part} />)}
      {live && message.parts.length === 0 ? <p className="text-ink-3 pulse-dot">Thinking…</p> : null}
      {message.error ? <div className="mt-2"><Note tone="bad">{message.error}</Note></div> : null}
    </div>
  );
}

const starters = (table?: Dataset): string[] => {
  if (!table) return [];
  const date = table.columns.find((c) => c.type === "date" || c.type === "datetime");
  const number = table.columns.find((c) => /revenue|sales|amount|spend|total/i.test(c.name)) ?? table.columns.find((c) => c.type === "number");
  const category = table.columns.find((c) => c.type === "text" && c.distinct > 1 && c.distinct <= 12);
  const list = [`Give me an overview of ${table.id}. What stands out?`];
  if (number && category) list.push(`Which ${category.name} has the highest ${number.name}?`);
  if (number && date) list.push(`Forecast ${number.name} for the next few periods`);
  const target = [...table.columns].reverse().find((c) => c.type === "boolean" || (c.type === "text" && c.distinct === 2));
  if (target) list.push(`What drives ${target.name}?`);
  return list;
};

export default function ChatPage() {
  const { data: chats, refresh: refreshChats } = useApi<ChatSummary[]>("/api/chats");
  const { data: datasets } = useApi<Dataset[]>("/api/datasets");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusTable, setFocusTable] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  const open = useCallback(async (id: string) => {
    setError(null);
    try {
      const chat = await api<{ id: string; ui: UiMessage[] }>(`/api/chats/${id}`);
      setActiveId(chat.id);
      setMessages(chat.ui);
      window.history.replaceState(null, "", `/chat?id=${chat.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    if (id) void open(id);
    setFocusTable(params.get("table"));
    const question = params.get("q");
    if (question) setDraft(question);
  }, [open]);

  useEffect(() => {
    const onScroll = () => {
      stick.current = window.innerHeight + window.scrollY > document.body.scrollHeight - 160;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const reset = () => {
    setActiveId(null);
    setMessages([]);
    setError(null);
    window.history.replaceState(null, "", "/chat");
    input.current?.focus();
  };

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;
    setDraft("");
    setError(null);
    setStreaming(true);
    stick.current = true;
    const abort = new AbortController();
    controller.current = abort;
    const user: UiMessage = { id: `u${Date.now()}`, role: "user", parts: [{ type: "text", text: trimmed }] };
    const assistantId = `a${Date.now()}`;
    setMessages((list) => [...list, user, { id: assistantId, role: "assistant", parts: [] }]);
    const update = (fn: (message: UiMessage) => UiMessage) => setMessages((list) => list.map((m) => (m.id === assistantId ? fn(m) : m)));

    try {
      let id = activeId;
      if (!id) {
        id = (await post<{ id: string }>("/api/chats")).id;
        setActiveId(id);
        window.history.replaceState(null, "", `/chat?id=${id}`);
      }
      const response = await fetch(`/api/chats/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
        signal: abort.signal,
      });
      await readStream<ChatEvent>(response, (event) => {
        if (event.type === "error") update((m) => ({ ...m, error: event.message }));
        else update((m) => ({ ...m, parts: applyChatEvent(m.parts, event) }));
      });
    } catch (e) {
      if (abort.signal.aborted) update((m) => ({ ...m, error: "Stopped." }));
      else update((m) => ({ ...m, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setStreaming(false);
      controller.current = null;
      void refreshChats();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send(draft);
    }
  };

  const remove = async (id: string) => {
    await api(`/api/chats/${id}`, { method: "DELETE" });
    if (id === activeId) reset();
    void refreshChats();
  };

  const focused = datasets?.find((d) => d.id === focusTable) ?? datasets?.[0];
  const noData = datasets?.length === 0;

  return (
    <div className="flex min-h-screen">
      <aside className="hidden lg:block w-56 shrink-0 border-r border-line sticky top-0 h-screen overflow-y-auto p-2">
        <Button className="w-full mb-2" onClick={reset}><Plus size={14} /> New chat</Button>
        {chats?.map((chat) => (
          <div key={chat.id} className={`group flex items-center rounded-md ${chat.id === activeId ? "bg-surface-2" : "hover:bg-surface-2"}`}>
            <button type="button" onClick={() => void open(chat.id)} className="flex-1 min-w-0 text-left truncate px-2.5 py-1.5 text-[13px] text-ink-2 cursor-pointer">{chat.title}</button>
            <button type="button" aria-label={`Delete ${chat.title}`} onClick={() => void remove(chat.id)} className="p-1.5 text-ink-3 hover:text-bad opacity-0 group-hover:opacity-100 focus:opacity-100 cursor-pointer"><Trash2 size={13} /></button>
          </div>
        ))}
      </aside>
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex-1 max-w-3xl w-full mx-auto px-4 md:px-6 pt-8 pb-4">
          {error ? <Note tone="bad">{error}</Note> : null}
          {messages.length === 0 ? (
            noData ? (
              <Empty title="Add data first" action={<Link href="/"><Button variant="primary">Add data</Button></Link>}>Chat works on the tables you have loaded.</Empty>
            ) : (
              <div className="pt-16">
                <h1 className="text-[22px] font-semibold tracking-tight">What do you want to know?</h1>
                <p className="text-ink-2 mt-1">Claude writes SQL against your tables, charts the results and checks its numbers. Questions, query results and sample rows are sent to the Anthropic API.</p>
                <div className="mt-5 grid sm:grid-cols-2 gap-2">
                  {starters(focused).map((prompt) => (
                    <button key={prompt} type="button" onClick={() => void send(prompt)} className="text-left rounded-xl border border-line bg-surface p-3 text-[13.5px] hover:border-ink-3 transition-colors cursor-pointer">{prompt}</button>
                  ))}
                </div>
              </div>
            )
          ) : (
            <div className="space-y-5">
              {messages.map((message, index) => <Message key={message.id} message={message} live={streaming && index === messages.length - 1} />)}
            </div>
          )}
          <div ref={bottom} className="h-1" />
        </div>
        <div className="sticky bottom-0 bg-gradient-to-t from-canvas via-canvas to-transparent pt-4 pb-4">
          <div className="max-w-3xl mx-auto px-4 md:px-6">
            <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface p-2 focus-within:border-ink-3">
              <textarea
                ref={input}
                rows={1}
                value={draft}
                disabled={noData}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Ask about your data"
                aria-label="Message"
                className="flex-1 resize-none bg-transparent px-2 py-1.5 outline-none max-h-40 field-sizing-content placeholder:text-ink-3"
              />
              {streaming ? (
                <Button variant="secondary" className="!px-2.5 !rounded-xl" aria-label="Stop" onClick={() => controller.current?.abort()}><Square size={14} /></Button>
              ) : (
                <Button variant="primary" className="!px-2.5 !rounded-xl" aria-label="Send" disabled={!draft.trim()} onClick={() => void send(draft)}><ArrowUp size={15} /></Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

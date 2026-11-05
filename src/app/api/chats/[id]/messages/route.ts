import { z } from "zod";
import { runChatTurn } from "@/lib/ai/chat";
import { aiErrorMessage } from "@/lib/ai/client";
import { json, ndjson } from "@/lib/api";
import { applyChatEvent } from "@/lib/chat-parts";
import { chats, newId } from "@/lib/store";
import type { ChatEvent, UiMessage, UiPart } from "@/lib/types";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  const parsed = z.object({ text: z.string().min(1).max(20000) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Empty message." }, 400);
  const chat = await chats.get(id).catch(() => null);
  if (!chat) return json({ error: "Chat not found." }, 404);
  const { text } = parsed.data;

  return ndjson<ChatEvent>(request, async (emit, signal) => {
    let parts: UiPart[] = [];
    const send = (event: ChatEvent) => {
      parts = applyChatEvent(parts, event);
      emit(event);
    };
    const user: UiMessage = { id: newId(), role: "user", parts: [{ type: "text", text }] };
    const assistant: UiMessage = { id: newId(), role: "assistant", parts: [] };
    const title = chat.ui.length === 0 ? text.slice(0, 60) : chat.title;

    try {
      await runChatTurn(chat, text, send, signal);
      emit({ type: "done", title });
    } catch (error) {
      if (signal.aborted) {
        assistant.error = "Stopped.";
      } else {
        assistant.error = aiErrorMessage(error);
        emit({ type: "error", message: assistant.error });
      }
    }
    assistant.parts = parts;
    chat.ui = [...chat.ui, user, assistant];
    chat.title = title;
    chat.updatedAt = new Date().toISOString();
    await chats.save(chat);
  });
}

import { json, route } from "@/lib/api";
import { chats } from "@/lib/store";

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>(async (_request, { params }) => {
  const { id } = await params;
  const chat = await chats.get(id);
  if (!chat) return json({ error: "Chat not found." }, 404);
  return json({ id: chat.id, title: chat.title, updatedAt: chat.updatedAt, ui: chat.ui });
});

export const DELETE = route<Context>(async (_request, { params }) => {
  const { id } = await params;
  await chats.remove(id);
  return json({ ok: true });
});

import { json, route } from "@/lib/api";
import { chats, newId } from "@/lib/store";

export const GET = route(async () => {
  const list = await chats.list();
  list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return json(list.map(({ id, title, updatedAt }) => ({ id, title, updatedAt })));
});

export const POST = route(async () => {
  const now = new Date().toISOString();
  const chat = { id: newId(), title: "New chat", createdAt: now, updatedAt: now, api: [], ui: [] };
  await chats.save(chat);
  return json(chat);
});

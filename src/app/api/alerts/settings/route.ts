import { z } from "zod";
import { json, route } from "@/lib/api";
import { sendTestNotification } from "@/lib/alerts/runner";
import { notifications } from "@/lib/store";
import type { NotificationSettingsView } from "@/lib/types";

async function view(): Promise<NotificationSettingsView> {
  const settings = await notifications.get("notifications");
  return {
    webhookConfigured: Boolean(settings?.webhookUrl),
    webhookHost: settings?.webhookUrl ? new URL(settings.webhookUrl).host : null,
    format: settings?.format ?? "slack",
  };
}

export const GET = route(async () => json(await view()));

const body = z.object({
  // Empty clears it. The URL is never sent back to the browser.
  webhookUrl: z.string().trim().max(2000).optional(),
  format: z.enum(["slack", "discord", "json"]),
});

export const PUT = route(async (request) => {
  const input = body.parse(await request.json());
  const current = await notifications.get("notifications");
  let webhookUrl = current?.webhookUrl;
  if (input.webhookUrl !== undefined) {
    if (input.webhookUrl === "") webhookUrl = undefined;
    else {
      const url = new URL(input.webhookUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") return json({ error: "Use an http or https URL." }, 400);
      webhookUrl = url.toString();
    }
  }
  await notifications.save({ id: "notifications", webhookUrl, format: input.format });
  return json(await view());
});

export const POST = route(async () => json(await sendTestNotification()));

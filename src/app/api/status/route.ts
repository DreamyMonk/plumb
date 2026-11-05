import { MODEL } from "@/lib/ai/client";
import { json } from "@/lib/api";
import { DATA_DIR } from "@/lib/db";

export async function GET() {
  return json({
    aiConfigured: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    model: MODEL,
    dataDir: DATA_DIR,
  });
}

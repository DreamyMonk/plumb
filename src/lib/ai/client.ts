import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";

export const MODEL = "claude-sonnet-5-5";

// fallbacks: "default" retries a safety-classifier decline on the model Anthropic
// recommends for that category. Benign data can occasionally trip a classifier, and
// a retry beats a dead end in the middle of an analysis.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
// Sonnet 5.5 puts longer between-tool notes in thinking blocks; this surfaces them.
const THINKING_UPDATES_BETA = "thinking-display-updates-2026-08-18";

export const CHAT_BETAS = [FALLBACK_BETA, THINKING_UPDATES_BETA];

const globalForClient = globalThis as unknown as { __anthropic?: Anthropic };

export function anthropic(): Anthropic {
  // Reads ANTHROPIC_API_KEY, or the profile from `ant auth login`.
  globalForClient.__anthropic ??= new Anthropic();
  return globalForClient.__anthropic;
}

/** JSON Schema for tool inputs and structured outputs. */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  return json;
}

export function aiErrorMessage(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "Claude rejected the API key. Check ANTHROPIC_API_KEY in .env.local and restart the app.";
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return "This API key does not have access to Claude Sonnet 5.5.";
  }
  if (error instanceof Anthropic.NotFoundError) {
    return "Claude Sonnet 5.5 was not found for this account.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Claude's rate limit was reached. Wait a moment and try again.";
  }
  if (error instanceof Anthropic.BadRequestError) {
    return `Claude could not process this request: ${error.message}`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Could not reach Claude. Check your internet connection.";
  }
  if (error instanceof Anthropic.APIError) {
    return `Claude returned an error (${error.status ?? "unknown"}). Try again in a moment.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/authentication method|apiKey|authToken/i.test(message)) {
    return "No Claude credentials found. Add ANTHROPIC_API_KEY to .env.local (see .env.example) and restart the app.";
  }
  return message;
}

export class RefusalError extends Error {
  constructor(category?: string | null) {
    super(`Claude declined this request${category ? ` (${category})` : ""}. Try rephrasing it.`);
  }
}

export function assertUsable(message: BetaMessage): void {
  if (message.stop_reason === "refusal") throw new RefusalError(message.stop_details?.category);
}

interface StructuredRequest<T extends z.ZodType> {
  system: string;
  prompt: string;
  schema: T;
  effort: "low" | "medium";
  signal?: AbortSignal;
}

/** One model call that returns validated JSON. */
export async function structured<T extends z.ZodType>({ system, prompt, schema, effort, signal }: StructuredRequest<T>): Promise<z.infer<T>> {
  const stream = anthropic().beta.messages.stream(
    {
      model: MODEL,
      max_tokens: 32000,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      system,
      messages: [{ role: "user", content: prompt }],
      // The SDK helper strips constraints structured outputs reject, such as the
      // minimum and maximum that z.int() adds.
      output_config: { effort, format: { type: "json_schema", schema: betaZodOutputFormat(schema).schema } },
    },
    { signal },
  );
  const message = await stream.finalMessage();
  assertUsable(message);
  if (message.stop_reason === "max_tokens") throw new Error("Claude's response was cut off. Try fewer tables.");
  const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  return schema.parse(JSON.parse(text));
}

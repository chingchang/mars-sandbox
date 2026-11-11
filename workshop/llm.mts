// The model behind the design agent. The server talks to the Claude API
// through the official SDK; tests inject a recorded Llm instead.
import Anthropic from "@anthropic-ai/sdk";

export type ChatMessage = { role: "user" | "assistant"; content: string };
export type Llm = (system: string, messages: ChatMessage[]) => Promise<string>;

export const DEFAULT_MODEL = "claude-opus-5-5";

export function anthropicLlm({ apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.WORKSHOP_MODEL || DEFAULT_MODEL, timeoutMs = 180_000 }:
  { apiKey?: string; model?: string; timeoutMs?: number } = {}): Llm {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set: copy .env.example to .env and fill it in");
  const client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 2 });
  return async (system, messages) => {
    const res = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // the system prompt is the same for every request until a shared file changes: cache it
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
      output_config: { effort: "high" },
    });
    if (res.stop_reason === "refusal") {
      const d = res.stop_details;
      throw new LlmError(`the model declined this request${d?.explanation ? ": " + d.explanation : d?.category ? " (" + d.category + ")" : ""}`, 422);
    }
    if (res.stop_reason === "max_tokens") throw new LlmError("the model's reply was cut off at max_tokens", 502);
    return res.content.filter(b => b.type === "text").map(b => b.text).join("");
  };
}

export class LlmError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

/** Map an error from the LLM call to an HTTP status and a message safe to show the player. */
export function describeLlmError(err: unknown): { status: number; message: string } {
  if (err instanceof LlmError) return { status: err.status, message: err.message };
  if (err instanceof Anthropic.AuthenticationError) return { status: 502, message: "the workshop's API key was rejected" };
  if (err instanceof Anthropic.RateLimitError) return { status: 503, message: "the model is rate limited; try again in a moment" };
  if (err instanceof Anthropic.APIConnectionError) return { status: 502, message: "could not reach the model" };
  if (err instanceof Anthropic.APIError) return { status: 502, message: `model API error ${err.status ?? ""}: ${err.message}`.trim() };
  return { status: 500, message: err instanceof Error ? err.message : String(err) };
}

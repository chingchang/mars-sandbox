// The workshop server: one endpoint. POST /workshop with the conversation so
// far, get back questions for the player or a tested module. The API key
// lives here and never reaches the browser. Run with `npm run workshop`.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { anthropicLlm, describeLlmError, DEFAULT_MODEL, type ChatMessage, type Llm } from "./llm.mts";
import { DEFAULT_TRIES, runWorkshop, type WorkshopOptions } from "./pipeline.mts";
import { buildSystemPrompt, liveFactIds, readIndex, readKeys, ROOT } from "./prompt.mts";

export const DEFAULT_PORT = 8787;
export const MAX_BODY_BYTES = 1 << 20, MAX_MESSAGES = 40, MAX_TRIES = 5;

class BadRequest extends Error {}

/** The conversation the page sends: user and assistant turns, user first, bounded. */
export function parseConversation(body: unknown): { messages: ChatMessage[]; tries: number } {
  if (!body || typeof body !== "object") throw new BadRequest("body must be a JSON object");
  const { messages, tries } = body as { messages?: unknown; tries?: unknown };
  if (!Array.isArray(messages) || messages.length === 0) throw new BadRequest("messages must be a non-empty array");
  if (messages.length > MAX_MESSAGES) throw new BadRequest(`at most ${MAX_MESSAGES} messages`);
  const out: ChatMessage[] = messages.map((m, i) => {
    const { role, content } = (m ?? {}) as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") throw new BadRequest(`messages[${i}].role must be "user" or "assistant"`);
    if (typeof content !== "string" || !content.trim()) throw new BadRequest(`messages[${i}].content must be a non-empty string`);
    return { role, content };
  });
  if (out[0].role !== "user") throw new BadRequest("the first message must be from the user");
  let n = DEFAULT_TRIES;
  if (tries !== undefined) {
    if (!Number.isInteger(tries) || (tries as number) < 1 || (tries as number) > MAX_TRIES) throw new BadRequest(`tries must be an integer from 1 to ${MAX_TRIES}`);
    n = tries as number;
  }
  return { messages: out, tries: n };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY_BYTES) { reject(new BadRequest(`body over ${MAX_BODY_BYTES} bytes`)); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, GET, OPTIONS" });
  res.end(JSON.stringify(body));
}

export type ServerOptions = { llm: Llm; model?: string } & Pick<WorkshopOptions, "index" | "keys" | "build">;

/** Build the HTTP server; the caller listens. Tests pass a recorded llm and a fake build. */
export function createWorkshopServer({ llm, model = DEFAULT_MODEL, index = readIndex(), keys = readKeys(), build }: ServerOptions) {
  const system = buildSystemPrompt({ index, keys });            // assembled once; the files it reads are part of the commit
  const facts = liveFactIds(index).length;
  return createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") return send(res, 204, {});
      if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, model, facts, system_bytes: system.length });
      if (req.url !== "/workshop") return send(res, 404, { error: "not found; POST /workshop" });
      if (req.method !== "POST") return send(res, 405, { error: "POST /workshop" });
      let body: unknown;
      try { body = JSON.parse(await readBody(req)); } catch (e) { if (e instanceof BadRequest) throw e; throw new BadRequest("body is not valid JSON"); }
      const { messages, tries } = parseConversation(body);
      const result = await runWorkshop({ messages, tries, llm, index, keys, system, ...(build ? { build } : {}) });
      return send(res, 200, result);
    } catch (e) {
      if (e instanceof BadRequest) return send(res, 400, { error: e.message });
      const { status, message } = describeLlmError(e);
      return send(res, status, { error: message });
    }
  });
}

export function loadEnv(root = ROOT) {
  const file = path.join(root, ".env");
  if (existsSync(file)) process.loadEnvFile(file);              // values already in the environment win
}

export function main() {
  loadEnv();
  const model = process.env.WORKSHOP_MODEL || DEFAULT_MODEL;
  let llm: Llm;
  try { llm = anthropicLlm({ model }); } catch (e) { console.error(`workshop: ${(e as Error).message}`); process.exit(2); }
  const port = Number(process.env.WORKSHOP_PORT) || DEFAULT_PORT;
  createWorkshopServer({ llm, model }).listen(port, "127.0.0.1", () => {
    console.log(`workshop: POST http://127.0.0.1:${port}/workshop  (model ${model}; key from .env, never sent to the page)`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

// The workshop server: one endpoint. POST /workshop with the conversation so
// far, get back questions for the player or a tested module. The API key
// lives here and never reaches the browser. Run with `npm run workshop`.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { anthropicLlm, describeLlmError, DEFAULT_MODEL, type ChatMessage, type Llm } from "./llm.mts";
import { DEFAULT_TRIES, runWorkshop, type WorkshopOptions } from "./pipeline.mts";
import { buildSystemPrompt, liveFactIds, readIndex, readKeys, ROOT } from "./prompt.mts";
import { buildQueue, BusyError, compileAndTest, type BuildQueue } from "./compile.mts";

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

/** Body up to MAX_BODY_BYTES; past that the rest is drained and tooLarge is set, so the client gets an answer instead of a reset. */
function readBody(req: IncomingMessage): Promise<{ text: string; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    let size = 0, tooLarge = false; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY_BYTES) tooLarge = true; else chunks.push(c); });
    req.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8"), tooLarge }));
    req.on("error", reject);
  });
}

/** Origins the page may call from without being listed: the local page on any port, http only. */
export const LOCAL_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
/** Host header values this server answers to unless more are configured (DNS rebinding sends another name). */
export const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

export function originAllowed(origin: string, extra: string[] = []): boolean { return LOCAL_ORIGIN.test(origin) || extra.includes(origin); }
export function hostAllowed(host: string, extra: string[] = []): boolean { return LOCAL_HOST.test(host) || extra.includes(host); }

function send(res: ServerResponse, status: number, body: unknown, cors: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...cors });
  res.end(JSON.stringify(body));
}

export type ServerOptions = { llm: Llm; model?: string; origins?: string[]; hosts?: string[]; queue?: BuildQueue } & Pick<WorkshopOptions, "index" | "keys" | "build">;

/**
 * Build the HTTP server; the caller listens. Tests pass a recorded llm and a fake build.
 * Every request costs the owner's key, so what may call it is checked before anything else:
 * the Host header must be local (or listed), a present Origin must be local (or listed), and
 * POST /workshop must declare application/json; anything else is refused before the body is
 * read or the model called. Requests with no Origin (curl, tests) pass the origin check.
 * Builds run one at a time (see compile.mts): a request is admitted only while the queue has
 * room for its build (one running plus four waiting); beyond that it gets 503 without the
 * model being called, and /health keeps answering throughout.
 */
export function createWorkshopServer({ llm, model = DEFAULT_MODEL, origins = [], hosts = [], index = readIndex(), keys = readKeys(), build, queue = buildQueue }: ServerOptions) {
  const system = buildSystemPrompt({ index, keys });            // assembled once; the files it reads are part of the commit
  const systemSha256 = createHash("sha256").update(system).digest("hex");
  const facts = liveFactIds(index).length;
  let admitted = 0;                                              // requests in flight; each holds at most one build at a time
  const doBuild = build ?? ((src: string) => compileAndTest(src, ROOT, {}, queue));   // compileAndTest queues itself; a custom build is the caller's business
  return createServer(async (req, res) => {
    const host = req.headers.host ?? "";
    if (!hostAllowed(host, hosts) || (req.headersDistinct.host?.length ?? 0) > 1) return send(res, 403, { error: `host "${host}" is not served; the workshop answers to localhost (WORKSHOP_HOSTS adds more)` });
    const origin = req.headers.origin;
    if (origin !== undefined && !originAllowed(origin, origins)) return send(res, 403, { error: `origin "${origin}" may not use the workshop; local pages only (WORKSHOP_ORIGINS adds more)` });
    const cors: Record<string, string> = origin === undefined ? {} : { "access-control-allow-origin": origin, "vary": "origin", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, GET, OPTIONS" };
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    try {
      if (req.method === "OPTIONS") return send(res, 204, {}, cors);
      if (req.method === "GET" && pathname === "/health") return send(res, 200, { ok: true, model, facts, system_bytes: system.length, system_sha256: systemSha256, in_flight: admitted, building: queue.running }, cors);
      if (pathname !== "/workshop") return send(res, 404, { error: "not found; POST /workshop" }, cors);
      if (req.method !== "POST") return send(res, 405, { error: "POST /workshop" }, cors);
      const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (type !== "application/json") return send(res, 415, { error: "content-type must be application/json" }, cors);
      const { text, tooLarge } = await readBody(req);
      if (tooLarge) return send(res, 413, { error: `body over ${MAX_BODY_BYTES} bytes` }, { ...cors, connection: "close" });
      let body: unknown;
      try { body = JSON.parse(text); } catch { throw new BadRequest("body is not valid JSON"); }
      const { messages, tries } = parseConversation(body);
      if (admitted >= 1 + queue.maxWaiting) return send(res, 503, { error: "the workshop is busy, try again in a moment" }, { ...cors, "retry-after": "5" });
      admitted++;
      try {
        const result = await runWorkshop({ messages, tries, llm, index, keys, system, build: doBuild });
        return send(res, 200, result, cors);
      } finally { admitted--; }
    } catch (e) {
      if (e instanceof BadRequest) return send(res, 400, { error: e.message }, cors);
      if (e instanceof BusyError) return send(res, 503, { error: e.message }, { ...cors, "retry-after": "5" });
      const { status, message } = describeLlmError(e);
      return send(res, status, { error: message }, cors);
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
  const list = (v: string | undefined) => (v ?? "").split(",").map(x => x.trim()).filter(Boolean);
  createWorkshopServer({ llm, model, origins: list(process.env.WORKSHOP_ORIGINS), hosts: list(process.env.WORKSHOP_HOSTS) }).listen(port, "127.0.0.1", () => {
    console.log(`workshop: POST http://127.0.0.1:${port}/workshop  (model ${model}; key from .env, never sent to the page)`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();

// The workshop server: one endpoint. POST /workshop with the conversation so
// far, get back questions for the player or a tested module. The API key
// lives here and never reaches the browser. Run with `npm run workshop`.
//
// In production (S1) the same process also serves the packed client from
// dist/ and stands behind three guards: an access code the player types once,
// a throttle on wrong codes, and a daily cap on model calls. Each is checked
// before the body is read or the model called. With no access code configured
// the server is local only (it refuses to bind elsewhere).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { anthropicLlm, describeLlmError, DEFAULT_MODEL, type ChatMessage, type Llm } from "./llm.mts";
import { DEFAULT_TRIES, runWorkshop, type WorkshopOptions } from "./pipeline.mts";
import { buildSystemPrompt, liveFactIds, readIndex, readKeys, ROOT } from "./prompt.mts";
import { buildQueue, BusyError, compileAndTest, type BuildQueue } from "./compile.mts";
import { bearer, ClosedError, codeMatches, DailyCap, DEFAULT_DAILY_CAP, Throttle } from "./guard.mts";
import { staticHandler } from "./static.mts";

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
/** Addresses the server may listen on without an access code. */
export const LOOPBACK = /^(?:127\.0\.0\.1|localhost|::1|\[::1\])$/;

/** `strict` (production) drops the local allowance: only the listed origins and hosts are served. */
export function originAllowed(origin: string, extra: string[] = [], strict = false): boolean { return (!strict && LOCAL_ORIGIN.test(origin)) || extra.includes(origin); }
export function hostAllowed(host: string, extra: string[] = [], strict = false): boolean { return (!strict && LOCAL_HOST.test(host)) || extra.includes(host); }

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/**
 * The address a wrong code is counted against. Behind Fly's proxy (`trustProxy`) it is
 * `Fly-Client-IP`, which the proxy sets to the address it accepted the connection from and a
 * client cannot supply (Fly's request-headers docs). Never `X-Forwarded-For`: the proxy appends
 * to whatever the client sent, so its leftmost entries are the client's to choose, which would
 * let a guesser rotate keys and a stranger lock a player out by naming their address. Without
 * a trusted proxy, the socket's own address.
 */
export function clientKey(req: Pick<IncomingMessage, "headers" | "socket">, trustProxy: boolean): string {
  const h = req.headers["fly-client-ip"];
  const fly = (Array.isArray(h) ? h[0] : h ?? "").trim();
  return (trustProxy && fly) || req.socket.remoteAddress || "?";
}

type Reply = (status: number, body: object, headers?: Record<string, string>) => void;

/**
 * A model call can run for minutes with nothing on the wire, and a proxy in front of the
 * server may close an idle response. In keepalive mode the status line goes out at once and
 * a space is written every `everyMs` until the answer is ready (JSON allows leading
 * whitespace). An outcome that would have been another status travels in the body as
 * { type: "error", status, error, ... }; the page reads it the same way.
 */
function startKeepalive(res: ServerResponse, headers: Record<string, string>, everyMs: number): Reply {
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "x-accel-buffering": "no", ...headers });
  res.flushHeaders();
  const timer = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(" "); }, everyMs);
  res.on("close", () => clearInterval(timer));
  return (status, body, extra = {}) => {
    clearInterval(timer);
    if (res.destroyed || res.writableEnded) return;
    const retry = extra["retry-after"] ? { retry_after: Number(extra["retry-after"]) } : {};
    res.end(JSON.stringify(status === 200 ? body : { type: "error", status, ...body, ...retry }));
  };
}

export type ServerOptions = {
  llm: Llm; model?: string; origins?: string[]; hosts?: string[]; queue?: BuildQueue;
  /** The shared secret players type once; unset means local only (no guard, full /health). */
  accessCode?: string;
  /** Model calls per UTC day (DEFAULT_DAILY_CAP), or a DailyCap of the test's own; `stateDir` keeps the count on disk across restarts. */
  dailyCap?: number; cap?: DailyCap; stateDir?: string; throttle?: Throttle;
  /** The clock, for tests that turn the day over. */
  now?: () => number;
  /** Serve the packed client from this directory; `staticConnect` adds origins to the page's connect-src. */
  staticDir?: string; staticConnect?: string[];
  /** Heartbeat interval while a request is in flight; 0 (local) sends plain responses. */
  keepaliveMs?: number;
  /** Count wrong codes against Fly-Client-IP (behind Fly's proxy, which sets it). */
  trustProxy?: boolean;
  /** Production: serve only the listed hosts and origins, with no local allowance, and plain 403 texts. */
  strict?: boolean;
} & Pick<WorkshopOptions, "index" | "keys" | "build">;

/**
 * Build the HTTP server; the caller listens. Tests pass a recorded llm and a fake build.
 * Every request costs the owner's key, so what may call it is checked before anything else:
 * the Host header must be local (or listed), a present Origin must be local (or listed), then
 * the access code (when one is configured) and the daily cap, then POST /workshop must declare
 * application/json; anything else is refused before the body is read or the model called.
 * Requests with no Origin (curl, tests) pass the origin check. /health answers { ok: true } to
 * any caller on a served host and its details only with the access code (or locally, with none).
 * Builds run one at a time (see compile.mts): a request is admitted only while the queue has
 * room for its build (one running plus four waiting); beyond that it gets 503 without the
 * model being called, and /health keeps answering throughout.
 */
export function createWorkshopServer({ llm, model = DEFAULT_MODEL, origins = [], hosts = [], index = readIndex(), keys = readKeys(), build, queue = buildQueue,
  accessCode, dailyCap = DEFAULT_DAILY_CAP, stateDir, cap = new DailyCap(dailyCap, stateDir ? path.join(stateDir, "daily_cap.json") : undefined), throttle = new Throttle(), now: clock = Date.now,
  staticDir, staticConnect = [], keepaliveMs = 0, trustProxy = false, strict = false }: ServerOptions) {
  const system = buildSystemPrompt({ index, keys });            // assembled once; the files it reads are part of the commit
  const systemSha256 = createHash("sha256").update(system).digest("hex");
  const facts = liveFactIds(index).length;
  const open = !accessCode;                                      // no code configured: local development
  let admitted = 0;                                              // requests in flight; each holds at most one build at a time
  const doBuild = build ?? ((src: string) => compileAndTest(src, ROOT, {}, queue));   // compileAndTest queues itself; a custom build is the caller's business
  const serve = staticDir ? staticHandler(staticDir, { connect: staticConnect }) : null;
  // every model call counts against the day, including the retries inside one request
  const guardedLlm: Llm = async (s, m) => { const t = clock(); if (!cap.take(t)) throw new ClosedError(cap.closedMessage(t), DailyCap.reopensAt(t)); return llm(s, m); };
  return createServer(async (req, res) => {
    const now = clock();
    const host = req.headers.host ?? "";
    const hostOk = hostAllowed(host, hosts, strict) && (req.headersDistinct.host?.length ?? 0) <= 1;
    const origin = req.headers.origin;
    const originOk = origin === undefined || originAllowed(origin, origins, strict);
    const cors: Record<string, string> = origin === undefined || !originOk ? {} : { "access-control-allow-origin": origin, "vary": "origin", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "POST, GET, OPTIONS" };
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const method = req.method ?? "GET";
    const presented = bearer(req.headers.authorization);
    if (!hostOk) return send(res, 403, { error: strict ? "not served" : `host "${host}" is not served; the workshop answers to localhost (WORKSHOP_HOSTS adds more)` });
    if (!originOk) return send(res, 403, { error: strict ? "not served" : `origin "${origin}" may not use the workshop; local pages only (WORKSHOP_ORIGINS adds more)` });
    if (method === "GET" && pathname === "/health") {
      // a presented code goes through the same throttle as /workshop, so /health is no faster an oracle for it
      let details = open;
      if (!open && presented !== undefined) {
        const key = clientKey(req, trustProxy);
        if (throttle.blockedFor(key, now)) details = false;
        else if (codeMatches(presented, accessCode)) details = true;
        else throttle.record(key, now);
      }
      if (!details) return send(res, 200, { ok: true }, cors);                          // nothing a stranger can use
      return send(res, 200, { ok: true, model, facts, system_bytes: system.length, system_sha256: systemSha256, in_flight: admitted, building: queue.running, calls_today: cap.used, daily_cap: cap.cap }, cors);
    }
    try {
      if (method === "OPTIONS") return send(res, 204, {}, cors);
      if (pathname !== "/workshop") {
        if (serve && serve(req, res)) return;
        return send(res, 404, { error: "not found; POST /workshop" }, cors);
      }
      if (method !== "POST") return send(res, 405, { error: "POST /workshop" }, cors);
      if (!open) {                                               // the guards, before the body is read
        const key = clientKey(req, trustProxy);
        const wait = throttle.blockedFor(key, now);
        if (wait) return send(res, 429, { error: `too many wrong access codes from this address; try again in ${wait} s`, code: "throttled" }, { ...cors, "retry-after": String(wait) });
        if (!codeMatches(presented, accessCode)) {
          throttle.record(key, now);
          return send(res, 401, { error: presented === undefined ? "this workshop needs an access code" : "that access code was not accepted", code: "unauthorized" }, cors);
        }
      }
      if (cap.remaining(now) === 0) return send(res, 429, { error: cap.closedMessage(now), code: "closed", reopens_at: DailyCap.reopensAt(now) }, { ...cors, "retry-after": String(Math.ceil((Date.parse(DailyCap.reopensAt(now)) - now) / 1000)) });
      const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (type !== "application/json") return send(res, 415, { error: "content-type must be application/json" }, cors);
      const { text, tooLarge } = await readBody(req);
      if (tooLarge) return send(res, 413, { error: `body over ${MAX_BODY_BYTES} bytes` }, { ...cors, connection: "close" });
      let body: unknown;
      try { body = JSON.parse(text); } catch { throw new BadRequest("body is not valid JSON"); }
      const { messages, tries } = parseConversation(body);
      if (admitted >= 1 + queue.maxWaiting) return send(res, 503, { error: "the workshop is busy, try again in a moment" }, { ...cors, "retry-after": "5" });
      admitted++;
      const reply: Reply = keepaliveMs > 0 ? startKeepalive(res, cors, keepaliveMs) : (status, b, extra = {}) => send(res, status, b, { ...cors, ...extra });
      try {
        const result = await runWorkshop({ messages, tries, llm: guardedLlm, index, keys, system, build: doBuild });
        return reply(200, result);
      } catch (e) {
        if (e instanceof BusyError) return reply(503, { error: e.message }, { "retry-after": "5" });
        if (e instanceof ClosedError) return reply(429, { error: e.message, code: "closed", reopens_at: e.reopensAt });
        const { status, message } = describeLlmError(e);
        return reply(status, { error: message });
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

export type EnvConfig = { bind: string; port: number; model: string; origins: string[]; hosts: string[]; accessCode?: string; dailyCap: number; stateDir?: string; keepaliveMs: number; staticDir?: string; staticConnect: string[]; trustProxy: boolean; strict: boolean };

/**
 * The server's configuration from the environment (see .env.example). Refuses a listen
 * address other than loopback without an access code: that would put the key's spend on
 * the open network.
 */
export function configFromEnv(env: Record<string, string | undefined> = process.env): EnvConfig {
  const list = (v: string | undefined) => (v ?? "").split(",").map(x => x.trim()).filter(Boolean);
  const bind = env.WORKSHOP_BIND || "127.0.0.1";
  const accessCode = env.WORKSHOP_ACCESS_CODE || undefined;
  if (!LOOPBACK.test(bind) && !accessCode) throw new Error(`WORKSHOP_BIND is ${bind} and WORKSHOP_ACCESS_CODE is not set: refusing to listen where anyone could spend the key`);
  const capText = env.WORKSHOP_DAILY_CAP;
  const dailyCap = capText === undefined || capText === "" ? DEFAULT_DAILY_CAP : Number(capText);
  new DailyCap(dailyCap);                                         // validates (a positive integer) before anything listens
  const keepaliveMs = Math.max(0, Number(env.WORKSHOP_KEEPALIVE_S) || 0) * 1000;
  const staticDir = env.WORKSHOP_STATIC ? path.resolve(ROOT, env.WORKSHOP_STATIC) : undefined;
  const stateDir = env.WORKSHOP_STATE_DIR ? path.resolve(ROOT, env.WORKSHOP_STATE_DIR) : undefined;
  const staticConnect: string[] = [];
  for (const u of list(env.WORKSHOP_URL)) { try { staticConnect.push(new URL(u).origin); } catch { throw new Error(`WORKSHOP_URL is not a URL: ${u}`); } }
  const origins = list(env.WORKSHOP_ORIGINS), hosts = list(env.WORKSHOP_HOSTS), strict = env.WORKSHOP_STRICT === "1";
  if (strict && (!origins.length || !hosts.length)) throw new Error("WORKSHOP_STRICT=1 needs WORKSHOP_HOSTS and WORKSHOP_ORIGINS, or nothing would be served");
  return { bind, port: Number(env.WORKSHOP_PORT) || DEFAULT_PORT, model: env.WORKSHOP_MODEL || DEFAULT_MODEL, origins, hosts,
    accessCode, dailyCap, stateDir, keepaliveMs, staticDir, staticConnect, trustProxy: env.WORKSHOP_TRUST_PROXY === "1", strict };
}

export function main() {
  loadEnv();
  let cfg: EnvConfig, llm: Llm;
  try { cfg = configFromEnv(); llm = anthropicLlm({ model: cfg.model }); } catch (e) { console.error(`workshop: ${(e as Error).message}`); process.exit(2); }
  const { bind, port, model, accessCode, dailyCap, stateDir, staticDir, keepaliveMs, strict, hosts, ...rest } = cfg;
  let server: ReturnType<typeof createWorkshopServer>;
  try { server = createWorkshopServer({ llm, model, accessCode, dailyCap, stateDir, staticDir, keepaliveMs, strict, hosts, ...rest }); } catch (e) { console.error(`workshop: ${(e as Error).message}`); process.exit(2); }
  server.listen(port, bind, () => {
    console.log(`workshop: listening on http://${bind}:${port} (model ${model}; access code ${accessCode ? "set" : "not set, local pages only"}; ${dailyCap} model calls a day, counted ${stateDir ? "in " + stateDir : "in memory"}; static ${staticDir ?? "off"}; keepalive ${keepaliveMs ? keepaliveMs / 1000 + " s" : "off"}; ${strict ? "only " + hosts.join(", ") : "local pages and " + (hosts.join(", ") || "no other host")}; key from the environment, never sent to the page)`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();

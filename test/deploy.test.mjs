// S1: what stands in front of the workshop once it has a public URL. The access code is
// checked before the body is parsed or the model called; wrong codes are throttled; the
// daily cap closes the workshop and the next UTC day reopens it (clock injected); the
// Host and Origin checks still apply with the code present; /health tells a stranger
// only "ok"; the packed client is served with a Content-Security-Policy and nosniff,
// never a path above dist/; keepalive mode streams whitespace and carries another
// status in the body; the environment refuses a public bind without a code.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkshopServer, configFromEnv, clientKey, hostAllowed, originAllowed } from "../workshop/server.mts";
import { bearer, codeMatches, DailyCap, Throttle, ClosedError } from "../workshop/guard.mts";
import { cspFor, importMapSources, staticHandler } from "../workshop/static.mts";
import { LlmError } from "../workshop/llm.mts";
import { readIndex, readKeys } from "../workshop/prompt.mts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = readIndex(), keys = readKeys();
const CODE = "open-sesame-42";
const QUESTIONS = "Before I build: which height should the sensor read at [jezero.temperature.my36_air_hourly_mean]?";
const fakeBuild = async () => ({ ok: true, wasm: new Uint8Array([0, 97, 115, 109]), report: "fake build" });
function counting(reply = QUESTIONS) { const calls = []; return { calls, llm: async (s, m) => { calls.push(m.length); return typeof reply === "function" ? reply() : reply; } }; }
const listen = srv => new Promise(r => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
/** A raw request (fetch refuses to set Origin and Host); resolves to { status, headers, text, json }. */
const raw = (port, method, p, headers = {}, body = null) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { ...(body ? { "content-length": Buffer.byteLength(body) } : {}), ...headers } }, res => {
    let text = ""; res.on("data", c => text += c); res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
  });
  req.on("error", reject); if (body) req.write(body); req.end();
});
const BODY = JSON.stringify({ messages: [{ role: "user", content: "a beacon" }] });
const json = { "content-type": "application/json" };
const withCode = (code = CODE) => ({ ...json, authorization: `Bearer ${code}` });

test("guard: bearer parsing, constant-time code match, the throttle window, the daily cap and its day", () => {
  assert.equal(bearer("Bearer abc"), "abc"); assert.equal(bearer("bearer  x-y_z "), "x-y_z"); assert.equal(bearer("Basic abc"), undefined); assert.equal(bearer(undefined), undefined); assert.equal(bearer(["Bearer a", "Bearer b"]), "a");
  assert.equal(codeMatches("a", "a"), true); assert.equal(codeMatches("a", "b"), false); assert.equal(codeMatches("", ""), false); assert.equal(codeMatches(undefined, "a"), false); assert.equal(codeMatches("a", undefined), false);
  assert.equal(codeMatches("abc", "abcd"), false, "different lengths compare without throwing");
  const t = new Throttle(3, 1000), t0 = 1_000_000;
  assert.equal(t.blockedFor("k", t0), 0);
  t.record("k", t0); t.record("k", t0 + 10); assert.equal(t.blockedFor("k", t0 + 20), 0, "two wrong of three allowed");
  t.record("k", t0 + 20); assert.equal(t.blockedFor("k", t0 + 30), 1, "the third blocks, for the rest of the window");
  assert.equal(t.blockedFor("other", t0 + 30), 0, "another client is not blocked");
  assert.equal(t.blockedFor("k", t0 + 1001), 0, "the window has passed once the oldest attempt ages out");
  for (let i = 0; i < 10_050; i++) t.record("c" + i, t0); assert.ok(t.clients <= 10_000, "bounded");
  const day = Date.UTC(2026, 10, 11, 23, 30), cap = new DailyCap(2);
  assert.equal(cap.remaining(day), 2); assert.equal(cap.take(day), true); assert.equal(cap.take(day), true); assert.equal(cap.take(day), false); assert.equal(cap.remaining(day), 0); assert.equal(cap.used, 2);
  assert.equal(DailyCap.reopensAt(day), "2026-11-12T00:00:00.000Z"); assert.match(cap.closedMessage(day), /closed for today.*2 model calls.*00:00 UTC, in about 1 hour/);
  assert.equal(cap.remaining(day + 31 * 60_000), 2, "the next UTC day starts the count over"); assert.equal(cap.used, 0);
  assert.throws(() => new DailyCap(0), /positive integer/); assert.throws(() => new DailyCap(1.5), /positive integer/);
  // on disk: the count survives a new process (a stopped machine, a restart); a day change resets it; a bad file starts over; a missing directory fails at start
  const dir = mkdtempSync(path.join(tmpdir(), "mars-cap-")), file = path.join(dir, "daily_cap.json");
  try {
    const a = new DailyCap(3, file); assert.equal(a.take(day), true); assert.equal(a.take(day), true);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { day: "2026-11-11", used: 2 });
    const b = new DailyCap(3, file); assert.equal(b.used, 2); assert.equal(b.remaining(day), 1, "a new instance picks up the day's count");
    assert.equal(b.take(day), true); assert.equal(new DailyCap(3, file).remaining(day), 0, "and the cap holds across instances");
    assert.equal(new DailyCap(3, file).remaining(day + 31 * 60_000), 3, "the next UTC day starts over"); assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { day: "2026-11-12", used: 0 });
    writeFileSync(file, "{not json"); assert.equal(new DailyCap(3, file).used, 0, "a bad file is not trusted");
    writeFileSync(file, JSON.stringify({ day: "2026-11-11", used: -4 })); assert.equal(new DailyCap(3, file).used, 0, "nor a negative count");
    assert.throws(() => new DailyCap(3, path.join(dir, "missing", "daily_cap.json")), /cannot be written/, "a missing state directory (an unmounted volume) fails at start");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.ok(new ClosedError("x", "2026-11-12T00:00:00.000Z") instanceof Error);
});

test("configFromEnv: defaults are local; a public bind without an access code is refused; the cap and the URL are validated", () => {
  const c = configFromEnv({});
  assert.equal(c.bind, "127.0.0.1"); assert.equal(c.port, 8787); assert.equal(c.accessCode, undefined); assert.equal(c.dailyCap, 50); assert.equal(c.keepaliveMs, 0); assert.equal(c.staticDir, undefined); assert.equal(c.trustProxy, false);
  assert.throws(() => configFromEnv({ WORKSHOP_BIND: "0.0.0.0" }), /refusing to listen/);
  assert.throws(() => configFromEnv({ WORKSHOP_BIND: "10.0.0.5" }), /refusing to listen/);
  const p = configFromEnv({ WORKSHOP_BIND: "0.0.0.0", WORKSHOP_ACCESS_CODE: CODE, WORKSHOP_DAILY_CAP: "7", WORKSHOP_KEEPALIVE_S: "20", WORKSHOP_STATIC: "dist", WORKSHOP_TRUST_PROXY: "1", WORKSHOP_HOSTS: "a.example, b.example", WORKSHOP_ORIGINS: "https://a.example", WORKSHOP_URL: "https://api.example/" });
  assert.equal(p.accessCode, CODE); assert.equal(p.dailyCap, 7); assert.equal(p.keepaliveMs, 20_000); assert.equal(p.staticDir, path.join(ROOT, "dist")); assert.equal(p.trustProxy, true);
  assert.deepEqual(p.hosts, ["a.example", "b.example"]); assert.deepEqual(p.origins, ["https://a.example"]); assert.deepEqual(p.staticConnect, ["https://api.example"]);
  assert.throws(() => configFromEnv({ WORKSHOP_DAILY_CAP: "0" }), /positive integer/);
  assert.throws(() => configFromEnv({ WORKSHOP_DAILY_CAP: "lots" }), /positive integer/);
  assert.throws(() => configFromEnv({ WORKSHOP_URL: "not a url" }), /not a URL/);
});

test("access code: no code and a wrong one are refused before the body is parsed or the model called; the right one passes; wrong codes are throttled per address", async () => {
  const { calls, llm } = counting();
  const throttle = new Throttle(3, 60_000);
  let t = Date.UTC(2026, 10, 11, 12);
  const server = createWorkshopServer({ llm, index, keys, build: fakeBuild, accessCode: CODE, throttle, now: () => t });
  const port = await listen(server);
  try {
    let r = await raw(port, "POST", "/workshop", json, "{not even json");
    assert.equal(r.status, 401); assert.equal(r.json.code, "unauthorized"); assert.match(r.json.error, /needs an access code/); assert.equal(calls.length, 0, "the body was not parsed (no 400) and the model not called");
    r = await raw(port, "POST", "/workshop", withCode("wrong"), BODY);
    assert.equal(r.status, 401); assert.match(r.json.error, /not accepted/); assert.equal(calls.length, 0);
    r = await raw(port, "POST", "/workshop", withCode(), BODY);
    assert.equal(r.status, 200); assert.equal(r.json.type, "questions"); assert.equal(calls.length, 1);
    r = await raw(port, "POST", "/workshop", withCode("wrong"), BODY); assert.equal(r.status, 401);        // third wrong attempt from this address
    r = await raw(port, "POST", "/workshop", withCode(), BODY);
    assert.equal(r.status, 429); assert.equal(r.json.code, "throttled"); assert.ok(Number(r.headers["retry-after"]) >= 1); assert.equal(calls.length, 1, "even the right code is refused while the address is throttled");
    t += 61_000;
    r = await raw(port, "POST", "/workshop", withCode(), BODY); assert.equal(r.status, 200); assert.equal(calls.length, 2, "the window passed");
    r = await raw(port, "POST", "/workshop", { ...json, authorization: "Basic abc" }, BODY); assert.equal(r.status, 401, "not a bearer token");
    r = await raw(port, "POST", "/workshop", { ...withCode(), "content-type": "text/plain" }, BODY); assert.equal(r.status, 415, "with the code, the other checks still run");
    r = await raw(port, "POST", "/workshop", withCode(), "{bad"); assert.equal(r.status, 400);
    r = await raw(port, "OPTIONS", "/workshop", { origin: "http://localhost:8000" }); assert.equal(r.status, 204); assert.match(r.headers["access-control-allow-headers"], /authorization/, "the preflight allows the header the page sends");
  } finally { server.close(); }
});

test("the throttle's key: Fly-Client-IP when the proxy is trusted, never X-Forwarded-For, so a rotating or forged forwarded header neither evades the throttle nor locks another address out", async () => {
  const fake = (headers, remote = "9.9.9.9") => ({ headers, socket: { remoteAddress: remote } });
  assert.equal(clientKey(fake({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }), true), "9.9.9.9", "X-Forwarded-For is never the key");
  assert.equal(clientKey(fake({ "fly-client-ip": "5.5.5.5", "x-forwarded-for": "1.1.1.1" }), true), "5.5.5.5");
  assert.equal(clientKey(fake({ "fly-client-ip": "5.5.5.5" }), false), "9.9.9.9", "not trusted: the socket");
  assert.equal(clientKey(fake({ "fly-client-ip": ["5.5.5.5", "6.6.6.6"] }), true), "5.5.5.5");
  const { llm } = counting();
  const server = createWorkshopServer({ llm, index, keys, build: fakeBuild, accessCode: CODE, throttle: new Throttle(3, 60_000), trustProxy: true });
  const port = await listen(server);
  try {
    // 20 wrong codes, each with a different client-chosen X-Forwarded-For: still one address (the socket, no Fly header), so the throttle holds
    const statuses = [];
    for (let i = 0; i < 20; i++) statuses.push((await raw(port, "POST", "/workshop", { ...withCode("x"), "x-forwarded-for": `${i}.${i}.${i}.${i}, 10.0.0.1` }, BODY)).status);
    assert.deepEqual(statuses.slice(0, 3), [401, 401, 401]); assert.ok(statuses.slice(3).every(s => s === 429), "rotating the forwarded header does not evade the throttle");
    // another client, as the proxy would present it, is not locked out by that
    let r = await raw(port, "POST", "/workshop", { ...withCode(), "fly-client-ip": "8.8.8.8" }, BODY); assert.equal(r.status, 200);
    // a forged X-Forwarded-For naming a player's address cannot block that player
    for (let i = 0; i < 5; i++) await raw(port, "POST", "/workshop", { ...withCode("x"), "fly-client-ip": "7.7.7.7", "x-forwarded-for": "8.8.8.8" }, BODY);
    r = await raw(port, "POST", "/workshop", { ...withCode(), "fly-client-ip": "8.8.8.8" }, BODY); assert.equal(r.status, 200, "8.8.8.8 is still served");
    r = await raw(port, "POST", "/workshop", { ...withCode(), "fly-client-ip": "7.7.7.7" }, BODY); assert.equal(r.status, 429, "7.7.7.7, the real sender, is throttled");
  } finally { server.close(); }
});

test("/health is no oracle for the code: a presented code goes through the throttle, wrong ones are recorded, and a blocked address gets the bare answer on both paths", async () => {
  const { calls, llm } = counting();
  let t = Date.UTC(2026, 10, 12, 12);
  const server = createWorkshopServer({ llm, index, keys, build: fakeBuild, accessCode: CODE, throttle: new Throttle(5, 600_000), now: () => t });
  const port = await listen(server);
  try {
    for (let i = 0; i < 5; i++) { const r = await raw(port, "GET", "/health", { authorization: `Bearer guess-${i}` }); assert.deepEqual(r.json, { ok: true }); }
    let r = await raw(port, "GET", "/health", { authorization: `Bearer ${CODE}` }); assert.deepEqual(r.json, { ok: true }, "five wrong guesses on /health: even the right code gets the bare answer");
    r = await raw(port, "POST", "/workshop", withCode(), BODY); assert.equal(r.status, 429, "and /workshop is blocked for the same address"); assert.equal(calls.length, 0);
    r = await raw(port, "GET", "/health"); assert.deepEqual(r.json, { ok: true }, "no code: bare, and not counted");
    t += 601_000;
    r = await raw(port, "GET", "/health", { authorization: `Bearer ${CODE}` }); assert.ok(r.json.system_sha256, "after the window the right code opens the details");
    for (let i = 0; i < 5; i++) await raw(port, "POST", "/workshop", withCode("x"), BODY);
    r = await raw(port, "GET", "/health", { authorization: `Bearer ${CODE}` }); assert.deepEqual(r.json, { ok: true }, "wrong codes on /workshop block /health details too");
  } finally { server.close(); }
});

test("strict mode: only the listed host and origin are served, local pages included, and the 403 says nothing more", async () => {
  assert.equal(hostAllowed("localhost:8787", [], true), false); assert.equal(hostAllowed("a.example", ["a.example"], true), true); assert.equal(hostAllowed("localhost:8787", ["a.example"]), true);
  assert.equal(originAllowed("http://localhost:8000", [], true), false); assert.equal(originAllowed("https://a.example", ["https://a.example"], true), true);
  assert.throws(() => configFromEnv({ WORKSHOP_STRICT: "1" }), /needs WORKSHOP_HOSTS and WORKSHOP_ORIGINS/);
  assert.equal(configFromEnv({ WORKSHOP_STRICT: "1", WORKSHOP_HOSTS: "a.example", WORKSHOP_ORIGINS: "https://a.example" }).strict, true);
  const { llm } = counting();
  const server = createWorkshopServer({ llm, index, keys, build: fakeBuild, accessCode: CODE, strict: true, hosts: ["sandbox.example"], origins: ["https://sandbox.example"] });
  const port = await listen(server);
  try {
    let r = await raw(port, "POST", "/workshop", withCode(), BODY); assert.equal(r.status, 403, "Host 127.0.0.1 is not served in strict mode"); assert.deepEqual(r.json, { error: "not served" });
    r = await raw(port, "POST", "/workshop", { ...withCode(), host: "sandbox.example", origin: "http://localhost:8000" }, BODY); assert.equal(r.status, 403); assert.deepEqual(r.json, { error: "not served" });
    r = await raw(port, "POST", "/workshop", { ...withCode(), host: "sandbox.example", origin: "https://sandbox.example" }, BODY); assert.equal(r.status, 200);
    r = await raw(port, "GET", "/health", { host: "localhost" }); assert.equal(r.status, 403);
  } finally { server.close(); }
});

test("daily cap: the day's model calls close the workshop before the body is read, retries inside a request count, and the next UTC day reopens it", async () => {
  let t = Date.UTC(2026, 10, 11, 22);
  const bad = "===MANIFEST===\n{}\n===SOURCE===\nexport function tick(dt: f64): void {}\n===EXPLANATION===\nx\n";   // fails the module check: another model call follows
  const { calls, llm } = counting(() => calls.length % 2 ? bad : QUESTIONS);      // first a bad module, then questions: two calls per request
  const server = createWorkshopServer({ llm, index, keys, build: fakeBuild, dailyCap: 3, now: () => t });
  const port = await listen(server);
  try {
    let r = await raw(port, "POST", "/workshop", json, BODY); assert.equal(r.status, 200); assert.equal(calls.length, 2, "a bad module then questions: two model calls in one request");
    assert.equal((await raw(port, "GET", "/health")).json.calls_today, 2);
    r = await raw(port, "POST", "/workshop", json, BODY); assert.equal(r.status, 429, "the second request's second call hits the cap mid-request");
    assert.equal(r.json.code, "closed"); assert.match(r.json.error, /closed for today/); assert.equal(r.json.reopens_at, "2026-11-12T00:00:00.000Z"); assert.equal(calls.length, 3);
    r = await raw(port, "POST", "/workshop", json, "{not json"); assert.equal(r.status, 429, "closed before the body is read"); assert.equal(r.json.code, "closed"); assert.ok(Number(r.headers["retry-after"]) > 0);
    r = await raw(port, "GET", "/health"); assert.equal(r.json.calls_today, 3); assert.equal(r.json.daily_cap, 3);
    t = Date.UTC(2026, 10, 12, 0, 0, 1);
    r = await raw(port, "POST", "/workshop", json, BODY); assert.equal(r.status, 200, "open again the next UTC day"); assert.equal(calls.length, 4);
  } finally { server.close(); }
  // with a state directory the count outlives the server: a second server (a restarted or woken machine) is still closed
  const dir = mkdtempSync(path.join(tmpdir(), "mars-state-"));
  try {
    const first = createWorkshopServer({ llm: counting().llm, index, keys, build: fakeBuild, dailyCap: 1, stateDir: dir, now: () => t });
    const p1 = await listen(first);
    try { assert.equal((await raw(p1, "POST", "/workshop", json, BODY)).status, 200); assert.equal((await raw(p1, "POST", "/workshop", json, BODY)).status, 429); } finally { first.close(); }
    const second = createWorkshopServer({ llm: counting().llm, index, keys, build: fakeBuild, dailyCap: 1, stateDir: dir, now: () => t });
    const p2 = await listen(second);
    try {
      const r = await raw(p2, "POST", "/workshop", json, BODY); assert.equal(r.status, 429, "the new server read the day's count from disk"); assert.equal(r.json.code, "closed");
      assert.equal((await raw(p2, "GET", "/health")).json.calls_today, 1);
    } finally { second.close(); }
    assert.equal(configFromEnv({ WORKSHOP_STATE_DIR: "/data" }).stateDir, "/data");
    assert.throws(() => createWorkshopServer({ llm: counting().llm, index, keys, build: fakeBuild, stateDir: path.join(dir, "nope") }), /cannot be written/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("with the code present a non-listed Origin or Host is still refused, and /health tells a stranger only ok", async () => {
  const { llm } = counting();
  const server = createWorkshopServer({ llm, index, keys, build: fakeBuild, accessCode: CODE, origins: ["https://sandbox.example"], hosts: ["sandbox.example"] });
  const port = await listen(server);
  try {
    let r = await raw(port, "POST", "/workshop", { ...withCode(), origin: "https://evil.example" }, BODY); assert.equal(r.status, 403);
    r = await raw(port, "POST", "/workshop", { ...withCode(), host: "evil.example" }, BODY); assert.equal(r.status, 403);
    r = await raw(port, "POST", "/workshop", { ...withCode(), host: "sandbox.example", origin: "https://sandbox.example" }, BODY); assert.equal(r.status, 200);
    r = await raw(port, "GET", "/health"); assert.deepEqual(r.json, { ok: true }, "no code: nothing else");
    r = await raw(port, "GET", "/health", { host: "evil.example" }); assert.equal(r.status, 403, "the Host check applies to /health too (the host's check sends the app's host)");
    r = await raw(port, "GET", "/health", { authorization: "Bearer nope" }); assert.deepEqual(r.json, { ok: true });
    r = await raw(port, "GET", "/health", { authorization: `Bearer ${CODE}` }); assert.equal(r.json.ok, true); assert.ok(r.json.system_sha256 && r.json.daily_cap === 50 && r.json.model, "the code opens the details");
    const open = createWorkshopServer({ llm, index, keys, build: fakeBuild }); const p2 = await listen(open);
    try { r = await raw(p2, "GET", "/health"); assert.ok(r.json.system_sha256, "no code configured (local): full health, as the acceptance runner expects"); } finally { open.close(); }
  } finally { server.close(); }
});

test("static client: served with a Content-Security-Policy (inline blocks by hash, the import map's CDN, wasm in workers, the workshop in connect-src), nosniff, and nothing above the directory", async () => {
  const html = `<!DOCTYPE html><html><head><style>body{margin:0}</style><script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"}}</script></head><body><script id="data" type="application/json">{"a":1}</script><script type="module">import "three"; new Worker("./runtime/worker.mjs", { type: "module" });</script></body></html>`;
  assert.deepEqual(importMapSources(html), ["https://cdn.jsdelivr.net/npm/three@0.170.0/build/"], "the directory the import map names, not the whole CDN");
  const csp = cspFor(html, { connect: ["https://api.example"] });
  assert.match(csp, /^default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.170\.0\/build\/ 'sha256-[A-Za-z0-9+/=]+' 'sha256-[A-Za-z0-9+/=]+' 'sha256-[A-Za-z0-9+/=]+'; worker-src 'self'; connect-src 'self' https:\/\/api\.example; style-src 'self' 'sha256-[A-Za-z0-9+/=]+'; img-src 'self' data: blob:; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'$/);
  assert.ok(!csp.includes("https://cdn.jsdelivr.net "), "no bare CDN origin anywhere in the policy");
  assert.ok(!csp.includes("'unsafe-inline'") && !csp.includes("'unsafe-eval'") && !csp.includes("'unsafe-hashes'"), "no unsafe-* allowance ('wasm-unsafe-eval' is the one for modules in workers)");
  const dir = mkdtempSync(path.join(tmpdir(), "mars-static-"));
  try {
    writeFileSync(path.join(dir, "index.html"), html); writeFileSync(path.join(dir, "worker.mjs"), "export {};"); writeFileSync(path.join(dir, "secret.txt"), "x");
    writeFileSync(path.join(path.dirname(dir), "outside-" + path.basename(dir)), "outside");
    assert.throws(() => staticHandler(path.join(dir, "nope")), /no index.html/);
    const { llm } = counting();
    const server = createWorkshopServer({ llm, index, keys, build: fakeBuild, staticDir: dir, staticConnect: ["https://api.example"] });
    const port = await listen(server);
    try {
      let r = await raw(port, "GET", "/"); assert.equal(r.status, 200); assert.match(r.headers["content-type"], /^text\/html/); assert.equal(r.headers["content-security-policy"], csp); assert.equal(r.headers["x-content-type-options"], "nosniff"); assert.equal(r.headers["referrer-policy"], "no-referrer"); assert.equal(r.headers["strict-transport-security"], "max-age=31536000"); assert.equal(r.headers["cache-control"], "no-cache"); assert.equal(r.text, html);
      r = await raw(port, "GET", "/index.html"); assert.equal(r.status, 200);
      r = await raw(port, "GET", "/worker.mjs"); assert.equal(r.status, 200); assert.match(r.headers["content-type"], /^text\/javascript/); assert.equal(r.headers["content-security-policy"], csp, "a worker script carries the policy"); assert.equal(r.headers["cache-control"], "public, max-age=3600");
      r = await raw(port, "HEAD", "/worker.mjs"); assert.equal(r.status, 200); assert.equal(r.text, ""); assert.equal(r.headers["content-length"], "10");
      for (const p of ["/../outside-" + path.basename(dir), "/%2e%2e/outside-" + path.basename(dir), "/..%2foutside-" + path.basename(dir), "/worker.mjs/../../outside-" + path.basename(dir), "/%00", "/nope.txt"]) { r = await raw(port, "GET", p); assert.equal(r.status, 404, p); }
      r = await raw(port, "GET", "/secret.txt?x=1"); assert.equal(r.status, 200, "a query string is not part of the path");
      r = await raw(port, "POST", "/index.html", json, "{}"); assert.equal(r.status, 404, "only GET and HEAD are files");
      r = await raw(port, "GET", "/workshop"); assert.equal(r.status, 405, "the endpoint is not shadowed");
      r = await raw(port, "GET", "/health"); assert.equal(r.json.ok, true);
    } finally { server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); try { rmSync(path.join(path.dirname(dir), "outside-" + path.basename(dir))); } catch {} }
  if (existsSync(path.join(ROOT, "dist/index.html"))) {                       // the real packed page: every inline block hashed, the one CDN, nothing inline unaccounted for
    const page = readFileSync(path.join(ROOT, "dist/index.html"), "utf8");
    const real = cspFor(page);
    assert.deepEqual(importMapSources(page).sort(), ["https://cdn.jsdelivr.net/npm/three@0.170.0/build/", "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"]);
    assert.equal((real.match(/'sha256-/g) ?? []).length, (page.match(/<script(?![^>]*\bsrc=)/gi) ?? []).length + (page.match(/<style/gi) ?? []).length);
    assert.ok(!/ on[a-z]+="/i.test(page), "no inline event handlers in the page (they would need 'unsafe-hashes')");
  }
});

test("keepalive mode: the status goes out at once, whitespace keeps the response alive, the answer follows; another outcome travels in the body with its status", async () => {
  const slow = async () => { await new Promise(r => setTimeout(r, 120)); return QUESTIONS; };
  const server = createWorkshopServer({ llm: slow, index, keys, build: fakeBuild, keepaliveMs: 25 });
  const port = await listen(server);
  try {
    const r = await raw(port, "POST", "/workshop", { ...json, origin: "http://localhost:8000" }, BODY);
    assert.equal(r.status, 200); assert.match(r.text, /^ {3,}\{/, "several heartbeats before the JSON"); assert.equal(r.json.type, "questions"); assert.equal(r.headers["access-control-allow-origin"], "http://localhost:8000");
    const declined = createWorkshopServer({ llm: async () => { throw new LlmError("the model declined this request", 422); }, index, keys, build: fakeBuild, keepaliveMs: 25 });
    const p2 = await listen(declined);
    try { const d = await raw(p2, "POST", "/workshop", json, BODY); assert.equal(d.status, 200); assert.deepEqual(d.json, { type: "error", status: 422, error: "the model declined this request" }); } finally { declined.close(); }
    let t = Date.UTC(2026, 10, 11, 12);
    const capped = createWorkshopServer({ llm: slow, index, keys, build: fakeBuild, keepaliveMs: 25, dailyCap: 1, now: () => t });
    const p3 = await listen(capped);
    try {
      assert.equal((await raw(p3, "POST", "/workshop", json, BODY)).status, 200);
      const c = await raw(p3, "POST", "/workshop", json, BODY); assert.equal(c.status, 429, "a cap reached before admission is a plain status"); assert.equal(c.json.code, "closed");
    } finally { capped.close(); }
  } finally { server.close(); }
});

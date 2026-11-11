// W2: the workshop panel, the real packed page driven in headless Chrome against a recorded
// model (no network, no key). three.js is served from node_modules in place of the CDN. One page
// is loaded once (software WebGL makes a page load the expensive part) and reused: each test
// points the panel at its own workshop server and resets the conversation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { createWorkshopServer } from "../workshop/server.mts";
import { BuildQueue } from "../workshop/compile.mts";
import { LlmError } from "../workshop/llm.mts";
import { readIndex, readKeys } from "../workshop/prompt.mts";
import { scanText } from "../scripts/check_secrets.mjs";
import { weakestTier, citationsFor, citedIds, nextStepFor, askWorkshop, moduleAnswerProblem, toCount, MAX_RETRIES_WHEN_BUSY } from "../web/workshop.mjs";

/** The file's budget: package.json runs it with --test-timeout of this; the safety timer fires 10 s before. Measured: 21-24 s here, 24 s on CI, 62 s on a 2-core machine under load (W2 review). A CPU throttle on the page thread changes nothing: the cost is software WebGL in Chrome's GPU process. */
export const PANEL_BUDGET_MS = 300_000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const index = readIndex(), keys = readKeys();
const read = p => readFileSync(path.join(ROOT, p), "utf8");
const STATION_SRC = read("behaviors/weather_station.ts");
const STATION_MANIFEST = JSON.parse(read("behaviors/weather_station.manifest.json"));
const BROKEN_SRC = STATION_SRC.replace("let flagUp: i32 = -1;", 'let flagUp: i32 = "x";');
const QUESTIONS = "Before I build: the MEDA mast measures air at 1.45 m [jezero.temperature.my36_air_hourly_mean]. Should your station read at that height, or lower? And is -70 C your own threshold, or should the flag follow the record's coldest hour?";
const EXPLANATION = "It reads the typical air temperature for the current hour over the measured year [jezero.temperature.my36_air_hourly_mean] and raises a cone when it drops below 203.15 K. The -70 C threshold is your choice, not a Mars fact.";
const moduleReply = (manifest, source, explanation = EXPLANATION) => `===MANIFEST===\n${JSON.stringify(manifest)}\n===SOURCE===\n${source}===EXPLANATION===\n${explanation}\n`;
function recorded(script) { const calls = []; return { calls, llm: async (system, messages) => { calls.push(messages.map(m => ({ ...m }))); if (!script.length) throw new Error("script exhausted"); const next = script.shift(); return typeof next === "function" ? next() : next; } }; }

const MIME = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".wasm": "application/wasm" };
function staticServer(dir) {
  return createServer((req, res) => {
    const pathname = new URL(req.url, "http://x").pathname;
    if (pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
    const p = path.join(dir, decodeURIComponent(pathname).replace(/\/$/, "/index.html"));
    if (!p.startsWith(dir) || !existsSync(p)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] ?? "application/octet-stream" }); res.end(readFileSync(p));
  });
}
/** A workshop impostor: answers any POST /workshop with whatever `answer(body)` returns ({ status, headers, json }), with CORS for the page. */
function fakeWorkshop(answer) {
  return createServer((req, res) => {
    const origin = req.headers.origin ?? "*";
    const cors = { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS", "access-control-expose-headers": "retry-after" };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
    let text = ""; req.on("data", c => text += c); req.on("end", () => { const a = answer(text); res.writeHead(a.status ?? 200, { "content-type": "application/json", ...cors, ...(a.headers ?? {}) }); res.end(JSON.stringify(a.json ?? {})); });
  });
}
const listen = (srv, host = "127.0.0.1") => new Promise(r => srv.listen(0, host, () => r(srv.address().port)));
const THREE = { "https://cdn.jsdelivr.net/npm/three@0.170.0/build/": path.join(ROOT, "node_modules/three/build/"), "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/": path.join(ROOT, "node_modules/three/examples/jsm/") };

let browser, pages, pagePort, page, errors = [], console_ = [];
before(async () => {
  assert.ok(existsSync(path.join(DIST, "index.html")), "dist/index.html exists (npm run pack)");
  pages = staticServer(DIST); pagePort = await listen(pages, "localhost");
  browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"] });
  page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  await page.setRequestInterception(true);
  page.on("request", req => {
    const u = req.url();
    for (const [prefix, dir] of Object.entries(THREE)) if (u.startsWith(prefix)) { const f = path.join(dir, u.slice(prefix.length)); return existsSync(f) ? req.respond({ status: 200, contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body: readFileSync(f) }) : req.abort(); }
    if (u.startsWith("http://localhost:") || u.startsWith("http://127.0.0.1:")) return req.continue();
    req.abort();                                                                    // nothing else leaves the machine
  });
  page.on("pageerror", e => errors.push(String(e))); page.on("console", m => { console_.push(m.type() + ": " + m.text()); if (m.type() === "error") errors.push(m.text()); });
  page.on("requestfailed", r => console_.push("requestfailed " + r.url() + " " + r.failure()?.errorText));
  if (process.env.PANEL_CPU_THROTTLE) await page.emulateCPUThrottling(Number(process.env.PANEL_CPU_THROTTLE));   // PANEL_CPU_THROTTLE=4 approximates a small 2-core machine
  await page.goto(`http://localhost:${pagePort}/index.html?terrain=procedural&fx=low&workshop=http://127.0.0.1:1`, { waitUntil: "load" });
  await page.waitForFunction(() => window.sandbox && window.sandbox.workshop, { timeout: 120000 });
});
after(async () => { await browser?.close(); pages?.close(); });
// If anything hangs past the file budget, node:test cancels the tests but the browser would keep the process alive: kill it.
setTimeout(() => { console.error("panel tests: safety timer fired, killing the browser"); try { browser?.process()?.kill("SIGKILL"); } catch {} pages?.close(); }, PANEL_BUDGET_MS - 10_000).unref();

/** Point the one page's panel at a workshop port and start a fresh conversation (and a fresh world). */
async function usePage(workshopPort, { width = 900, height = 700 } = {}) {
  errors = []; console_ = [];
  await page.setViewport({ width, height });
  await page.evaluate(port => {
    window.sandbox.workshop.workshopUrl = `http://127.0.0.1:${port}`; window.sandbox.workshop.reset();
    for (const o of window.sandbox.registry.list()) if (o.id !== "rover") { window.sandbox.registry.remove(o.id); }
    document.getElementById("inspector").hidden = true; document.getElementById("hud").classList.remove("collapsed");
  }, workshopPort);
  return page;
}
const text = (sel) => page.$eval(sel, e => e.textContent);
// buttons are clicked through the DOM: a hit-test click can race the canvas resize that follows every HUD change
const click = (sel) => page.$eval(sel, e => e.click());
async function say(msg) {
  await page.evaluate(() => document.getElementById("hud").classList.remove("collapsed"));
  assert.ok(await page.$eval("#ws-input", e => e.offsetParent !== null && !e.disabled), "the workshop input is visible and enabled");
  await page.$eval("#ws-input", e => { e.value = ""; });
  await page.type("#ws-input", msg);
  assert.equal(await page.$eval("#ws-input", e => e.value), msg, "the message was typed");
  await click("#ws-send");
}
const diag = async () => `status="${await text("#ws-status").catch(() => "?")}" thread="${(await text("#ws-thread").catch(() => "?")).slice(0, 300)}" console=${JSON.stringify(console_.slice(-8))}`;
async function waitFor(sel, timeout) { try { await page.waitForSelector(sel, { timeout }); } catch (e) { throw new Error(`${e.message}\n${await diag()}`); } }
async function waitUntil(fn, timeout, what) { try { await page.waitForFunction(fn, { timeout }); } catch (e) { throw new Error(`${what}: ${e.message}\n${await diag()}`); } }

test("helpers: weakest tier, citations, cited ids, next steps, counts and answer shapes", () => {
  assert.equal(weakestTier(index, ["mars.time.sol"]), "measured");
  assert.equal(weakestTier(index, ["astro.au", "mars.time.sol"]), "measured", "defined is stronger than measured");
  const modeled = Object.keys(index.facts).find(id => index.facts[id].tier === "modeled");
  assert.equal(weakestTier(index, ["mars.time.sol", modeled]), "modeled");
  assert.equal(weakestTier(index, ["no.such.fact"]), null); assert.equal(weakestTier(index, []), null);
  const c = citationsFor(index, "jezero.temperature.my36_air_hourly_mean");
  assert.equal(c.known, true); assert.equal(c.tier, "measured"); assert.match(c.sources[0].citation, /PDS Atmospheres/); assert.match(c.sources[0].url, /^https:\/\//);
  assert.equal(citationsFor(index, "no.such.fact").known, false);
  assert.deepEqual(citedIds(EXPLANATION), ["jezero.temperature.my36_air_hourly_mean"]);
  for (const kind of ["failed", "declined", "busy", "unreachable", "refused", "error"]) {
    const s = nextStepFor({ kind, tries: 3, error: "x", url: "http://u", retryAfter: 5 });
    assert.ok(s.title && !/\bno\b|cannot|can't/i.test(s.title.replace("could not get this version", "")), `${kind}: ${s.title}`);
    assert.ok(kind === "busy" ? s.retry && !s.question : s.question, `${kind} offers a next step`);
  }
  const ex = nextStepFor({ kind: "busy", exhausted: true, attempts: 7 });
  assert.match(ex.title, /still busy after 7 tries/); assert.equal(ex.retry, false); assert.match(ex.question, /send it again in a minute/);
  assert.match(nextStepFor({ kind: "unreachable", url: "http://127.0.0.1:1" }).detail, /npm run workshop/);
  assert.deepEqual([toCount(3), toCount("<img>"), toCount(-1), toCount(2.5), toCount(undefined)], [3, 0, 0, 0, 0]);
  assert.equal(moduleAnswerProblem({ name: "x", wasm: "AA==", manifest: {} }), null);
  assert.equal(moduleAnswerProblem({ name: "x", wasm: "AA==" }), "no manifest");
  assert.equal(moduleAnswerProblem({ name: "x", manifest: {} }), "no module bytes");
  assert.equal(moduleAnswerProblem({ name: "<b>", wasm: "AA==", manifest: {} }), "bad name");
});

test("askWorkshop maps every answer shape without throwing", async () => {
  const mk = (status, body, headers = {}) => async () => ({ status, ok: status < 300, headers: { get: k => headers[k] ?? null }, json: async () => body });
  assert.deepEqual(await askWorkshop("http://x", [], { fetchImpl: mk(200, { type: "questions", text: "q" }) }), { kind: "questions", text: "q" });
  assert.equal((await askWorkshop("http://x", [], { fetchImpl: mk(503, { error: "busy" }, { "retry-after": "7" }) })).retryAfter, 7);
  assert.equal((await askWorkshop("http://x", [], { fetchImpl: mk(422, { error: "declined" }) })).kind, "declined");
  assert.equal((await askWorkshop("http://x", [], { fetchImpl: mk(403, { error: "origin" }) })).kind, "refused");
  assert.equal((await askWorkshop("http://x", [], { fetchImpl: async () => { throw new TypeError("Failed to fetch"); } })).kind, "unreachable");
  assert.equal((await askWorkshop("http://x", [], { fetchImpl: mk(200, { type: "failed", error: "e", tries: 3, log: [] }) })).kind, "failed");
  const own = await askWorkshop("http://x", [], { fetchImpl: mk(200, { type: "module", kind: "failed", error: { x: 1 }, name: "x", wasm: "AA==", manifest: {} }) });
  assert.equal(own.kind, "module"); assert.equal(own.error, undefined, "a body's own kind and error are ignored");
  assert.equal((await askWorkshop("http://x", [], { fetchImpl: mk(200, { type: "module", kind: "busy", retryAfter: 1, name: "x", wasm: "AA==", manifest: {} }) })).kind, "module");
  const malformed = await askWorkshop("http://x", [], { fetchImpl: mk(200, { type: "module", name: "x", wasm: "AA==" }) });
  assert.equal(malformed.kind, "error"); assert.match(malformed.message, /malformed \(no manifest\)/);
  assert.equal((await askWorkshop("http://x", [], { fetchImpl: mk(200, { type: "module", name: "x", wasm: "AA==", manifest: {}, tries: "<img src=x onerror=1>" }) })).tries, 0);
});

test("panel: questions, answer, proposal with report and did-you-know, confirm, object placed at the tapped spot, inspector with the assumptions", async () => {
  const { llm } = recorded([QUESTIONS, moduleReply(STATION_MANIFEST, STATION_SRC)]);
  const ws = createWorkshopServer({ llm, index, keys });
  const wport = await listen(ws);
  await usePage(wport);
  try {
    // a real tap (not a drag) on the ground, above the HUD (its bar toggles the panel): try a few points down the middle
    const rect = await page.evaluate(() => { const r = document.getElementById("scene").getBoundingClientRect(); const hud = document.getElementById("hud").getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: Math.min(r.bottom, hud.top) - r.top }; });
    for (const fy of [0.6, 0.7, 0.8, 0.5, 0.9]) {
      await page.mouse.click(rect.left + rect.width * 0.5, rect.top + rect.height * fy);
      await new Promise(r => setTimeout(r, 300));
      if (await page.evaluate(() => /target set at/.test(document.getElementById("log").textContent))) break;
    }
    await waitUntil(() => /target set at/.test(document.getElementById("log").textContent), 5000, "tap on the ground");
    const tapped = await page.$eval("#log", e => { const all = [...e.textContent.matchAll(/target set at (-?[\d.]+), (-?[\d.]+)/g)]; return all.at(-1).slice(1, 3).map(Number); });
    await say("a weather station that raises a red flag when it gets really cold");
    await waitFor("#ws-thread .turn.agent", 30000);
    const q = await text("#ws-thread .turn.agent");
    assert.match(q, /Should your station read at that height/); assert.ok(await page.$("#ws-thread .turn.agent .factref"), "the fact id in the question is a chip");
    assert.match(await text("#ws-status"), /question for you/);
    await say("1.45 m is fine, and -70 C is my own threshold");
    await waitUntil(() => !document.getElementById("ws-proposal").hidden, 90000, "proposal");
    const prop = await text("#ws-proposal");
    assert.match(prop, /weather station/); assert.match(prop, /Built and tested in 1 try/); assert.match(prop, /ok: 600 ticks/); assert.match(prop, /\d+ over the 2 ms budget/);
    assert.match(prop, /Did you know\?/); assert.match(prop, /PDS Atmospheres/); assert.match(prop, /your own assumption/);
    assert.equal(await page.$eval("#ws-proposal .pill.tier-measured", e => e.textContent), "measured");
    assert.equal(await page.evaluate(() => window.sandbox.registry.list().length), 1, "nothing is placed before the player confirms");
    await click("#ws-place");
    await waitUntil(() => /is live as/.test(document.getElementById("ws-status").textContent), 30000, "placement");
    const placed = await page.evaluate(() => { const o = window.sandbox.registry.list().find(o => o.id !== "rover"); return { id: o.id, x: o.position.x, z: o.position.z, enabled: window.sandbox.registry.enabled(o.id), owner: o.owner, name: o.manifest?.name }; });
    assert.equal(placed.id, "weather_station-1"); assert.equal(placed.enabled, true); assert.equal(placed.owner, "player"); assert.equal(placed.name, "weather station");
    assert.ok(Math.abs(placed.x - tapped[0]) < 0.6 && Math.abs(placed.z - tapped[1]) < 0.6, `placed at the tapped spot (${placed.x}, ${placed.z}) vs (${tapped})`);
    await waitUntil(() => window.sandbox.registry.list().find(o => o.id === "weather_station-1").shapes.size >= 2, 15000, "shapes");
    await waitUntil(() => !document.getElementById("inspector").hidden, 5000, "inspector open");
    const insp = await text("#inspector");
    assert.match(insp, /weather station/); assert.match(insp, /air temperature now/); assert.match(insp, /weakest tier: measured/); assert.match(insp, /PDS Atmospheres/); assert.match(insp, /Did you know\?/);
    assert.match(insp, /How it was designed/); assert.match(insp, /The -70 C threshold is your choice, not a Mars fact/); assert.match(insp, /without a fact id in brackets is the player's own assumption/);
    assert.ok(await page.$("#inspector .pexpl .factref"), "the explanation's fact id is a chip in the inspector");
    assert.ok(await page.$("#inspector a[href^='https://']"), "a citation links to its source");
    // built once, refreshed in place: the same DOM nodes survive the refresh cadence and the slot values move
    const mark = await page.evaluate(() => { const a = document.querySelector("#inspector a[href^='https://']"); a.dataset.mark = "kept"; return document.querySelector("#inspector [data-slot='1']")?.textContent; });
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(await page.$eval("#inspector a[href^='https://']", a => a.dataset.mark), "kept", "the inspector was not rebuilt while open");
    await waitUntil(() => /\d+ ticks/.test(document.querySelector("#inspector [data-ticks]").textContent) && /\d+\.\d\d/.test(document.querySelector("#inspector [data-slot='1']").textContent), 10000, "live values");
    assert.ok(await page.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector("#inspector .cite")); return r.toString().length > 10; }), "citation text is selectable");
    assert.match(await text("#ws-thread"), /Did you know\?/, "the created object gets the did-you-know line in the thread");
    assert.match(await text("#log"), /placed weather_station-1 from the workshop/);
    // removing the object takes its explanation with it, closes the inspector and clears the Objects list entry
    assert.equal(await page.evaluate(() => window.sandbox.explanations.has("weather_station-1")), true);
    await page.evaluate(() => window.sandbox.removeObject("weather_station-1"));
    assert.deepEqual(await page.evaluate(() => [window.sandbox.explanations.size, document.getElementById("inspector").hidden, [...document.querySelectorAll("#objects .chip")].map(c => c.dataset.object)]), [0, true, ["rover"]]);
    assert.deepEqual(errors.filter(e => !/WebGL|GPU|swiftshader/i.test(e)), [], "no page errors");
  } finally { ws.close(); }
});

test("panel: a failed build is a next step, never a no, and the undelivered-message rule does not apply to it", async () => {
  const { llm } = recorded([moduleReply(STATION_MANIFEST, BROKEN_SRC), moduleReply(STATION_MANIFEST, BROKEN_SRC), moduleReply(STATION_MANIFEST, BROKEN_SRC)]);
  const ws = createWorkshopServer({ llm, index, keys });
  const wport = await listen(ws);
  await usePage(wport);
  try {
    await say("a thing");
    await waitFor("#ws-thread .turn.agent.next", 60000);
    const t = await text("#ws-thread .turn.agent.next");
    assert.match(t, /tried 3 times and could not get this version through its tests/); assert.match(t, /COMPILER ERROR/); assert.match(t, /What would you like to change\?/);
    assert.ok(!(await page.$eval("#ws-input", e => e.disabled)), "the player can go on");
    assert.match(await text("#ws-thread"), /what each try hit/);
    assert.deepEqual(await page.evaluate(() => window.sandbox.workshop.messages.map(m => m.role)), ["user", "assistant"], "the failed try stays in the history as the model saw it");
  } finally { ws.close(); }
});

test("panel: a busy workshop is shown as trying again, the retry goes through once a slot frees; when retries run out it is a next step with the message restored", async () => {
  let release; const slow = new Promise(r => { release = r; });
  const held = recorded([async () => { await slow; return QUESTIONS; }, QUESTIONS]);
  const busyWs = createWorkshopServer({ llm: held.llm, index, keys, queue: new BuildQueue(0) });   // one admitted request at a time
  const bport = await listen(busyWs);
  const holder = fetch(`http://127.0.0.1:${bport}/workshop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "first" }] }) });
  await new Promise(r => setTimeout(r, 300));
  await usePage(bport);
  try {
    await say("second");
    await waitUntil(() => /busy/.test(document.getElementById("ws-status").textContent), 10000, "busy status");
    assert.match(await text("#ws-status"), /Trying again in \d+ s/);
    assert.equal(held.calls.length, 1, "the second request never reached the model");
    release();
    assert.equal((await (await holder).json()).type, "questions");
    await waitFor("#ws-thread .turn.agent", 20000);
    assert.match(await text("#ws-thread .turn.agent"), /Should your station/, "the retry went through after the slot freed");
    assert.equal(held.calls.length, 2);
  } finally { busyWs.close(); }
  // always busy: after MAX_RETRIES_WHEN_BUSY retries the panel stops with a next step, the message back in the box, nothing sent twice later
  let hits = 0;
  const always = fakeWorkshop(() => { hits++; return { status: 503, headers: { "retry-after": "1" }, json: { error: "the workshop is busy, try again in a moment" } }; });
  const aport = await listen(always);
  await usePage(aport);
  try {
    await say("third");
    await waitFor("#ws-thread .turn.agent.next", 30000);
    const t = await text("#ws-thread .turn.agent.next");
    assert.match(t, new RegExp(`still busy after ${MAX_RETRIES_WHEN_BUSY + 1} tries`)); assert.match(t, /send it again in a minute/);
    assert.equal(hits, MAX_RETRIES_WHEN_BUSY + 1, "one request per try, then it stopped");
    assert.equal(await page.$eval("#ws-input", e => e.value), "third", "the undelivered message is back in the box");
    assert.deepEqual(await page.evaluate(() => window.sandbox.workshop.messages), [], "and not in the history, so a later send cannot carry it twice");
    await new Promise(r => setTimeout(r, 2500)); assert.equal(hits, MAX_RETRIES_WHEN_BUSY + 1, "no further requests");
  } finally { always.close(); }
});

test("panel: markup from the server is never rendered; a malformed module answer is a next step; a declined request is a next step; nothing key-like reaches the page; a bad manifest is refused", async () => {
  const marker = "ZZ" + Math.random().toString(36).slice(2) + "ZZ";
  let n = 0;
  const impostor = fakeWorkshop(() => {
    n++;
    if (n === 1) return { json: { type: "module", name: "sneaky", wasm: Buffer.from(readFileSync(path.join(ROOT, "build/patrol.wasm"))).toString("base64"), manifest: { name: "sneaky", description: "d", version: 1, author: "a" }, explanation: "e", report: "r", tries: `<img src=x onerror="window.${marker}=1">`, fact_ids: [] } };
    if (n === 2) return { json: { type: "failed", error: "boom", tries: 1, log: [{ attempt: `<img src=x onerror="window.${marker}=1">`, ok: false, error: "x" }] } };
    if (n === 3) return { json: { type: "module", name: "x", wasm: "AA==" } };                                          // no manifest
    if (n === 4) return { json: { type: "module", kind: "failed", error: { not: "a string" }, name: "sneaky", wasm: Buffer.from(readFileSync(path.join(ROOT, "build/patrol.wasm"))).toString("base64"), manifest: { name: "sneaky", description: "d", version: 1, author: "a" }, explanation: "e", report: "r", tries: 1 } };
    if (n === 5) return { json: { type: "module", kind: "busy", retryAfter: 1, name: "sneaky", wasm: Buffer.from(readFileSync(path.join(ROOT, "build/patrol.wasm"))).toString("base64"), manifest: { name: "sneaky", description: "d", version: 1, author: "a" }, explanation: "e", report: "r", tries: 1 } };
    return { status: 422, json: { error: "the model declined this request: outside what the workshop builds" } };
  });
  const iport = await listen(impostor);
  await usePage(iport);
  try {
    await say("one");
    await waitUntil(() => !document.getElementById("ws-proposal").hidden, 15000, "proposal from the impostor");
    assert.match(await text("#ws-proposal"), /Built and tested in 0 tries/);
    assert.equal(await page.evaluate(() => document.querySelector("#ws-proposal img")), null, "no element came from the tries field");
    await page.evaluate(() => window.sandbox.workshop.reset());
    await say("two");
    await waitFor("#ws-thread .turn.agent.next", 15000);
    assert.match(await text("#ws-thread .turn.host"), /try 1: x/);
    assert.equal(await page.evaluate(() => document.querySelector("#ws-thread img")), null, "no element came from the attempt field");
    assert.equal(await page.evaluate(m => window[m], marker), undefined, "no script from the server ran");
    await page.evaluate(() => window.sandbox.workshop.reset());
    await say("three");
    await waitFor("#ws-thread .turn.agent.next", 15000);
    assert.match(await text("#ws-thread .turn.agent.next"), /malformed \(no manifest\); nothing was loaded/);
    assert.equal(await page.$eval("#ws-proposal", e => e.hidden), true);
    assert.equal(await page.$eval("#ws-status", e => e.hidden), true, "no stale 'Built and tested' status");
    for (const word of ["four", "five"]) {                                                     // a body with its own kind: still a proposal, no retry, no throw
      await page.evaluate(() => window.sandbox.workshop.reset());
      const before = n;
      await say(word);
      await waitUntil(() => !document.getElementById("ws-proposal").hidden, 15000, `proposal despite kind in the body (${word})`);
      assert.match(await text("#ws-proposal"), /sneaky/); assert.equal(n, before + 1, "one request, no retries");
      assert.ok(!/Asking the design agent/.test(await text("#ws-status")), "no stale status");
    }
    await page.evaluate(() => window.sandbox.workshop.reset());
    await say("six");
    await waitFor("#ws-thread .turn.agent.next", 15000);
    const t = await text("#ws-thread .turn.agent.next");
    assert.match(t, /stepped back from this one/); assert.match(t, /outside what the workshop builds/); assert.match(t, /ask the agent what it could build toward the same goal/);
    for (const f of ["index.html", "workshop.mjs"]) assert.deepEqual(scanText(readFileSync(path.join(DIST, f), "utf8")), [], f);
    assert.deepEqual(scanText(await page.content()), []);
    assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage), document.cookie]), [[], [], ""]);
    const patrol = readFileSync(path.join(ROOT, "build/patrol.wasm")).toString("base64");
    const outcome = await page.evaluate(async b64 => { try { await window.sandbox.placeFromWorkshop({ name: "bad", wasm: b64, manifest: { name: "bad" }, tries: 1, fact_ids: [] }); return "placed"; } catch (e) { return "refused: " + e.message; } }, patrol);
    assert.match(outcome, /^refused: bad manifest/);
    assert.deepEqual(await page.evaluate(() => window.sandbox.registry.list().map(o => o.id)), ["rover"]);
    assert.deepEqual(errors.filter(e => !/WebGL|GPU|swiftshader|Failed to load resource/i.test(e)), []);
  } finally { impostor.close(); }
});

test("panel: an unreachable workshop server says how to start it and how to open the page, and gives the message back", async () => {
  await usePage(1);                                                                     // nothing listens on port 1
  await say("hello?");
  await waitFor("#ws-thread .turn.agent.next", 20000);
  const t = await text("#ws-thread .turn.agent.next");
  assert.match(t, /not reachable at http:\/\/127\.0\.0\.1:1/); assert.match(t, /npm run workshop/); assert.match(t, /http:\/\/localhost:8000/);
  assert.equal(await page.$eval("#ws-input", e => e.value), "hello?");
  assert.deepEqual(await page.evaluate(() => window.sandbox.workshop.messages), []);
});

test("panel: phone-width viewport, collapsible, usable, with the proposal and the inspector open", async () => {
  const { llm } = recorded([QUESTIONS, moduleReply(STATION_MANIFEST, STATION_SRC)]);
  const ws = createWorkshopServer({ llm, index, keys });
  const wport = await listen(ws);
  await usePage(wport, { width: 375, height: 700 });
  try {
    await page.evaluate(() => document.getElementById("hud").classList.add("collapsed"));
    assert.equal(await page.$eval("#body", e => getComputedStyle(e).display), "none", "collapsed hides the body");
    await click("#bar");
    assert.notEqual(await page.$eval("#body", e => getComputedStyle(e).display), "none");
    const box = await page.$eval("#ws-input", e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; });
    assert.ok(box.left >= 0 && box.right <= 375 && box.width > 200, `the input fits the phone width: ${JSON.stringify(box)}`);
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= 375 && [...document.querySelectorAll("#hud *")].every(e => e.getBoundingClientRect().right <= 376));
    assert.equal(await noOverflow(), true, "no horizontal overflow");
    await say("a dust gauge");
    await waitFor("#ws-thread .turn.agent", 30000);
    await say("fine");
    await waitUntil(() => !document.getElementById("ws-proposal").hidden, 90000, "proposal at phone width");
    assert.equal(await noOverflow(), true, "no overflow with the proposal open");
    await click("#ws-place");
    await waitUntil(() => !document.getElementById("inspector").hidden, 30000, "inspector at phone width");
    assert.equal(await noOverflow(), true, "no overflow with the inspector open");
  } finally { ws.close(); await page.setViewport({ width: 900, height: 700 }); }
});

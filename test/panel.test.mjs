// W2: the workshop panel, the real packed page driven in headless Chrome against a recorded
// model (no network, no key). three.js is served from node_modules in place of the CDN.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { createWorkshopServer } from "../workshop/server.mts";
import { LlmError } from "../workshop/llm.mts";
import { scanText } from "../scripts/check_secrets.mjs";
import { BuildQueue } from "../workshop/compile.mts";
import { readIndex, readKeys } from "../workshop/prompt.mts";
import { weakestTier, citationsFor, citedIds, nextStepFor, askWorkshop } from "../web/workshop.mjs";

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
const listen = (srv, host = "127.0.0.1") => new Promise(r => srv.listen(0, host, () => r(srv.address().port)));
const THREE = { "https://cdn.jsdelivr.net/npm/three@0.170.0/build/": path.join(ROOT, "node_modules/three/build/"), "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/": path.join(ROOT, "node_modules/three/examples/jsm/") };

let browser, pages, pagePort;
before(async () => {
  assert.ok(existsSync(path.join(DIST, "index.html")), "dist/index.html exists (npm run pack)");
  pages = staticServer(DIST); pagePort = await listen(pages, "localhost");
  browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"] });
});
after(async () => { await browser?.close(); pages?.close(); });
// If anything hangs past the file budget, node:test cancels the tests but the browser would keep the process alive: kill it.
setTimeout(() => { console.error("panel tests: safety timer fired, killing the browser"); try { browser?.process()?.kill("SIGKILL"); } catch {} pages?.close(); }, 110_000).unref();

/** A page at the packed app, with three.js served locally and the workshop URL pointed at `workshopPort`. */
async function openPage(workshopPort, { width = 900, height = 700 } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.setRequestInterception(true);
  page.on("request", req => {
    const u = req.url();
    for (const [prefix, dir] of Object.entries(THREE)) if (u.startsWith(prefix)) { const f = path.join(dir, u.slice(prefix.length)); return existsSync(f) ? req.respond({ status: 200, contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body: readFileSync(f) }) : req.abort(); }
    if (u.startsWith("http://localhost:") || u.startsWith("http://127.0.0.1:")) return req.continue();
    req.abort();                                                                    // nothing else leaves the machine
  });
  const errors = [], console_ = [];
  page.on("pageerror", e => errors.push(String(e))); page.on("console", m => { console_.push(m.type() + ": " + m.text()); if (m.type() === "error") errors.push(m.text()); });
  page.on("requestfailed", r => console_.push("requestfailed " + r.url() + " " + r.failure()?.errorText));
  page.on("response", r => { if (r.url().includes("/workshop")) console_.push("response " + r.status() + " " + r.url()); });
  await page.goto(`http://localhost:${pagePort}/index.html?terrain=procedural&workshop=http://127.0.0.1:${workshopPort}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.sandbox && window.sandbox.workshop, { timeout: 30000 });
  await page.evaluate(() => document.getElementById("hud").classList.remove("collapsed"));
  page.diag = async () => `status="${await page.$eval("#ws-status", e => e.textContent).catch(() => "?")}" thread="${await page.$eval("#ws-thread", e => e.textContent.slice(0, 300)).catch(() => "?")}" console=${JSON.stringify(console_.slice(-12))}`;
  return { page, errors };
}
/** waitForSelector with the page's own diagnostics in the failure message. */
async function waitFor(page, sel, timeout) { try { await page.waitForSelector(sel, { timeout }); } catch (e) { throw new Error(`${e.message}\n${await page.diag()}`); } }
const text = (page, sel) => page.$eval(sel, e => e.textContent);
// buttons are clicked through the DOM: a hit-test click can race the canvas resize that follows every HUD change
const click = (page, sel) => page.$eval(sel, e => e.click());
async function say(page, msg) {
  await page.evaluate(() => document.getElementById("hud").classList.remove("collapsed"));
  assert.ok(await page.$eval("#ws-input", e => e.offsetParent !== null && !e.disabled), "the workshop input is visible and enabled");
  await page.type("#ws-input", msg);
  assert.equal(await page.$eval("#ws-input", e => e.value), msg, "the message was typed");
  await click(page, "#ws-send");
}

test("helpers: weakest tier, citations, cited ids, next steps", () => {
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
  assert.match(nextStepFor({ kind: "unreachable", url: "http://127.0.0.1:1" }).detail, /npm run workshop/);
});

test("askWorkshop maps every answer shape without throwing", async () => {
  const mk = (status, body, headers = {}) => async () => ({ status, ok: status < 300, headers: { get: k => headers[k] ?? null }, json: async () => body });
  assert.deepEqual(await askWorkshop("http://x", [], { fetchImpl: mk(200, { type: "questions", text: "q" }) }), { kind: "questions", text: "q" });
  assert.equal((await askWorkshop("http://x", [], { fetchImpl: mk(503, { error: "busy" }, { "retry-after": "7" }) })).retryAfter, 7);
  assert.equal((await askWorkshop("http://x", [], { fetchImpl: mk(422, { error: "declined" }) })).kind, "declined");
  assert.equal((await askWorkshop("http://x", [], { fetchImpl: mk(403, { error: "origin" }) })).kind, "refused");
  assert.equal((await askWorkshop("http://x", [], { fetchImpl: async () => { throw new TypeError("Failed to fetch"); } })).kind, "unreachable");
  assert.equal((await askWorkshop("http://x", [], { fetchImpl: mk(200, { type: "failed", error: "e", tries: 3, log: [] }) })).kind, "failed");
});

test("panel: questions, answer, proposal with report and did-you-know, confirm, object placed at the tapped spot, inspector", async () => {
  const { llm } = recorded([QUESTIONS, moduleReply(STATION_MANIFEST, STATION_SRC)]);
  const ws = createWorkshopServer({ llm, index, keys });
  const wport = await listen(ws);
  const { page, errors } = await openPage(wport);
  try {
    await page.evaluate(() => { window.sandbox.registry; });
    // choose where it goes: a tap on the ground is a pointerdown/up without a drag
    // a real tap (not a drag) on the ground: try a few points down the middle of the view until one hits the terrain
    // the ground is the part of the canvas above the HUD (the HUD's bar toggles the panel, so never tap there)
    const rect = await page.evaluate(() => { const r = document.getElementById("scene").getBoundingClientRect(); const hud = document.getElementById("hud").getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: Math.min(r.bottom, hud.top) - r.top }; });
    for (const fy of [0.6, 0.7, 0.8, 0.5, 0.9]) {
      await page.mouse.click(rect.left + rect.width * 0.5, rect.top + rect.height * fy);
      await new Promise(r => setTimeout(r, 300));
      if (await page.evaluate(() => /target set at/.test(document.getElementById("log").textContent))) break;
    }
    await page.waitForFunction(() => /target set at/.test(document.getElementById("log").textContent), { timeout: 5000 });
    const tapped = await page.$eval("#log", e => /target set at (-?[\d.]+), (-?[\d.]+)/.exec(e.textContent).slice(1, 3).map(Number));
    await say(page, "a weather station that raises a red flag when it gets really cold");
    await waitFor(page, "#ws-thread .turn.agent", 20000);
    const q = await text(page, "#ws-thread .turn.agent");
    assert.match(q, /Should your station read at that height/); assert.ok(await page.$("#ws-thread .turn.agent .factref"), "the fact id in the question is a chip");
    assert.match(await text(page, "#ws-status"), /question for you/);
    await say(page, "1.45 m is fine, and -70 C is my own threshold");
    await page.waitForFunction(() => !document.getElementById("ws-proposal").hidden, { timeout: 60000 });
    const prop = await text(page, "#ws-proposal");
    assert.match(prop, /weather station/); assert.match(prop, /Built and tested in 1 try/); assert.match(prop, /ok: 600 ticks/); assert.match(prop, /\d+ over the 2 ms budget/);
    assert.match(prop, /Did you know\?/); assert.match(prop, /PDS Atmospheres/); assert.match(prop, /your own assumption/);
    assert.equal(await page.$eval("#ws-proposal .pill.tier-measured", e => e.textContent), "measured");
    assert.equal(await page.evaluate(() => window.sandbox.registry.list().length), 1, "nothing is placed before the player confirms");
    await click(page, "#ws-place");
    await page.waitForFunction(() => /is live as/.test(document.getElementById("ws-status").textContent), { timeout: 20000 });
    const placed = await page.evaluate(() => { const o = window.sandbox.registry.list().find(o => o.id !== "rover"); return { id: o.id, x: o.position.x, z: o.position.z, enabled: window.sandbox.registry.enabled(o.id), shapes: o.shapes.size, owner: o.owner, name: o.manifest?.name }; });
    assert.equal(placed.id, "weather_station-1"); assert.equal(placed.enabled, true); assert.equal(placed.owner, "player"); assert.equal(placed.name, "weather station");
    assert.ok(Math.abs(placed.x - tapped[0]) < 0.6 && Math.abs(placed.z - tapped[1]) < 0.6, `placed at the tapped spot (${placed.x}, ${placed.z}) vs (${tapped})`);
    await page.waitForFunction(() => window.sandbox.registry.list().find(o => o.id === "weather_station-1").shapes.size >= 2, { timeout: 10000 });
    await page.waitForFunction(() => !document.getElementById("inspector").hidden);
    const insp = await text(page, "#inspector");
    assert.match(insp, /weather station/); assert.match(insp, /air temperature now/); assert.match(insp, /weakest tier: measured/); assert.match(insp, /PDS Atmospheres/); assert.match(insp, /Did you know\?/);
    assert.ok(await page.$("#inspector a[href^='https://']"), "a citation links to its source");
    await page.waitForFunction(() => /\d+\.\d\d/.test(document.querySelector("#inspector .stats").textContent), { timeout: 10000 });
    assert.match(await text(page, "#ws-thread"), /Did you know\?/, "the created object gets the did-you-know line in the thread");
    assert.match(await text(page, "#log"), /placed weather_station-1 from the workshop/);
    assert.deepEqual(errors.filter(e => !/WebGL|GPU|swiftshader/i.test(e)), [], "no page errors");
  } finally { await page.close(); ws.close(); }
});

test("panel: a failed build is a next step, never a no", async () => {
  const { llm } = recorded([moduleReply(STATION_MANIFEST, BROKEN_SRC), moduleReply(STATION_MANIFEST, BROKEN_SRC), moduleReply(STATION_MANIFEST, BROKEN_SRC)]);
  const ws = createWorkshopServer({ llm, index, keys });
  const wport = await listen(ws);
  const { page } = await openPage(wport);
  try {
    await say(page, "a thing");
    await page.waitForSelector("#ws-thread .turn.agent.next", { timeout: 30000 });
    const t = await text(page, "#ws-thread .turn.agent.next");
    assert.match(t, /tried 3 times and could not get this version through its tests/); assert.match(t, /COMPILER ERROR/); assert.match(t, /What would you like to change\?/);
    assert.ok(!(await page.$eval("#ws-input", e => e.disabled)), "the player can go on");
    assert.match(await text(page, "#ws-thread"), /what each try hit/);
  } finally { await page.close(); ws.close(); }
});

test("panel: a busy workshop is shown as trying again, and the retry goes through once a slot frees", async () => {
  let release; const slow = new Promise(r => { release = r; });
  const held = recorded([async () => { await slow; return QUESTIONS; }, QUESTIONS]);
  const busyWs = createWorkshopServer({ llm: held.llm, index, keys, queue: new BuildQueue(0) });   // one admitted request at a time
  const bport = await listen(busyWs);
  // the slot is held by a request from here (a second rendering page would starve the first in software WebGL)
  const holder = fetch(`http://127.0.0.1:${bport}/workshop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "first" }] }) });
  await new Promise(r => setTimeout(r, 300));
  const { page } = await openPage(bport);
  try {
    await say(page, "second");
    await page.waitForFunction(() => /busy/.test(document.getElementById("ws-status").textContent), { timeout: 10000 });
    assert.match(await text(page, "#ws-status"), /Trying again in \d+ s/);
    assert.equal(held.calls.length, 1, "the second request never reached the model");
    release();
    assert.equal((await (await holder).json()).type, "questions");
    await page.waitForSelector("#ws-thread .turn.agent", { timeout: 15000 });
    assert.match(await text(page, "#ws-thread .turn.agent"), /Should your station/, "the retry went through after the slot freed");
    assert.equal(held.calls.length, 2);
  } finally { await page.close(); busyWs.close(); }
});

test("panel: a declined request is a next step; nothing key-like reaches the page or its storage; a bad manifest is refused on the page", async () => {
  const ws = createWorkshopServer({ llm: async () => { throw new LlmError("the model declined this request: outside what the workshop builds", 422); }, index, keys });
  const wport = await listen(ws);
  const { page } = await openPage(wport);
  try {
    await say(page, "something the agent steps back from");
    await page.waitForSelector("#ws-thread .turn.agent.next", { timeout: 15000 });
    const t = await text(page, "#ws-thread .turn.agent.next");
    assert.match(t, /stepped back from this one/); assert.match(t, /outside what the workshop builds/); assert.match(t, /ask the agent what it could build toward the same goal/);
    // the key never reaches the page: nothing key-shaped in the served files, the DOM, or anything the page stored
    for (const f of ["index.html", "workshop.mjs"]) assert.deepEqual(scanText(readFileSync(path.join(DIST, f), "utf8")), [], f);
    assert.deepEqual(scanText(await page.content()), []);
    assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage), document.cookie]), [[], [], ""]);
    // a module whose manifest does not validate is refused by the page's own registry path, and leaves no object behind
    const patrol = readFileSync(path.join(ROOT, "build/patrol.wasm")).toString("base64");
    const outcome = await page.evaluate(async b64 => { try { await window.sandbox.placeFromWorkshop({ name: "bad", wasm: b64, manifest: { name: "bad" }, tries: 1, fact_ids: [] }); return "placed"; } catch (e) { return "refused: " + e.message; } }, patrol);
    assert.match(outcome, /^refused: bad manifest/);
    assert.deepEqual(await page.evaluate(() => window.sandbox.registry.list().map(o => o.id)), ["rover"]);
  } finally { await page.close(); ws.close(); }
});

test("panel: an unreachable workshop server says how to start it and how to open the page", async () => {
  const { page } = await openPage(1);                                                     // nothing listens on port 1
  try {
    await say(page, "hello?");
    await page.waitForSelector("#ws-thread .turn.agent.next", { timeout: 15000 });
    const t = await text(page, "#ws-thread .turn.agent.next");
    assert.match(t, /not reachable at http:\/\/127\.0\.0\.1:1/); assert.match(t, /npm run workshop/); assert.match(t, /http:\/\/localhost:8000/);
  } finally { await page.close(); }
});

test("panel: phone-width viewport, collapsible, usable", async () => {
  const { llm } = recorded([QUESTIONS]);
  const ws = createWorkshopServer({ llm, index, keys });
  const wport = await listen(ws);
  const { page } = await openPage(wport, { width: 375, height: 700 });
  try {
    await page.evaluate(() => document.getElementById("hud").classList.add("collapsed"));
    assert.equal(await page.$eval("#body", e => getComputedStyle(e).display), "none", "collapsed hides the body");
    await click(page, "#bar");
    assert.notEqual(await page.$eval("#body", e => getComputedStyle(e).display), "none");
    const box = await page.$eval("#ws-input", e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; });
    assert.ok(box.left >= 0 && box.right <= 375 && box.width > 200, `the input fits the phone width: ${JSON.stringify(box)}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 375), true, "no horizontal overflow");
    await say(page, "a dust gauge");
    await page.waitForSelector("#ws-thread .turn.agent", { timeout: 20000 });
    const tb = await page.$eval("#ws-thread .turn.agent", e => e.getBoundingClientRect().right);
    assert.ok(tb <= 375, "the agent's turn fits");
  } finally { await page.close(); ws.close(); }
});

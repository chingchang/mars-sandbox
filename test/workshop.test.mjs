// W1: the workshop server. The model is recorded (no network, no key): a
// conversation that asks first and then builds the weather station through the
// real asc compiler and the real smoke test; the retry loop on a broken first
// answer; fact-id checks against the index; the HTTP endpoint; the key scanner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSystemPrompt, factKeyName, factLines, liveFactIds, principles, readIndex, readKeys, REPLY_PROTOCOL } from "../workshop/prompt.mts";
import { checkModule, MARKERS, moduleSpecifiers, parseReply, runWorkshop, slug, stripComments } from "../workshop/pipeline.mts";
import { compileAndTest, compileSource } from "../workshop/compile.mts";
import { createWorkshopServer, hostAllowed, originAllowed, parseConversation } from "../workshop/server.mts";
import { scanRepo, scanText } from "../scripts/check_secrets.mjs";
import { validateManifest } from "../runtime/manifest.mjs";
import { memoryPolicy } from "../runtime/wasm_limits.mjs";
import { MAX_MEMORY_PAGES } from "../runtime/registry.mjs";

const root = new URL("..", import.meta.url);
const read = p => readFileSync(new URL(p, root), "utf8");
const index = readIndex(), keys = readKeys();
const STATION_SRC = read("behaviors/weather_station.ts");
const STATION_MANIFEST = JSON.parse(read("behaviors/weather_station.manifest.json"));
const SUPERSEDED = Object.keys(index.facts).find(id => index.facts[id].superseded_by);

const moduleReply = (manifest, source, explanation = "It reads the typical hour's temperature [jezero.temperature.my36_air_hourly_mean]. The -70 C threshold is your choice.") =>
  `===MANIFEST===\n\`\`\`json\n${JSON.stringify(manifest, null, 1)}\n\`\`\`\n===SOURCE===\n\`\`\`typescript\n${source}\`\`\`\n===EXPLANATION===\n${explanation}\n`;
const QUESTIONS = "Two questions before I build. Which height should the sensor sit at: the 1.45 m of the MEDA mast [jezero.temperature.my36_air_hourly_mean], or your own? And is -70 C your threshold, or should the flag follow the record's coldest hour?";
/** A recorded model: returns the scripted replies in order and keeps what it was asked. */
function recorded(script) {
  const calls = [];
  const llm = async (system, messages) => { calls.push({ system, messages: messages.map(m => ({ ...m })) }); if (!script.length) throw new Error("script exhausted"); return script.shift(); };
  return { llm, calls };
}
const BROKEN_SRC = STATION_SRC.replace("let flagUp: i32 = -1;", 'let flagUp: i32 = "not a number";');       // type error
const IDLE_SRC = 'import { read } from "./host";\nexport function init(): void {}\nexport function tick(dt: f32): void { read(0); }\n';   // compiles, does nothing
/** A raw request (fetch refuses to send Origin and Host headers); resolves to { status, headers, json }. */
const raw = (port, method, path, headers = {}, body = null) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, method, path, headers: { ...(body ? { "content-length": Buffer.byteLength(body) } : {}), ...headers } }, res => {
    let text = ""; res.on("data", c => text += c); res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, json }); });
  });
  req.on("error", reject); if (body) req.write(body); req.end();
});
const fakeBuild = async () => ({ ok: true, wasm: Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), report: "fake build" });

test("system prompt: every live fact id, no superseded id, the shared files and the principles, deterministic", () => {
  const live = liveFactIds(index);
  assert.ok(live.length > 60 && SUPERSEDED, "the index has live and superseded facts");
  assert.ok(!live.includes(SUPERSEDED));
  const sys = buildSystemPrompt({ index, keys });
  for (const id of live) assert.ok(sys.includes(`\n- ${id} [`), `${id} is listed`);
  for (const id of Object.keys(index.facts).filter(id => index.facts[id].superseded_by)) assert.ok(!sys.includes(`\n- ${id} [`), `${id} is superseded and not listed`);
  assert.ok(sys.includes("## Principle 1") && sys.includes("What this rules out") && !sys.includes("## Where things live"));
  assert.equal(principles(), principles());
  assert.ok(sys.includes("fact(key)") && sys.includes("manifest.schema.json") && sys.includes('"did_you_know"') && sys.includes("weather station") && sys.includes(REPLY_PROTOCOL));
  assert.ok(sys.includes("Never make one up") && sys.includes(index.content_hash));
  assert.equal(sys, buildSystemPrompt({ index, keys }), "same inputs, same prompt (so it caches)");
  const sol = factLines(index, keys).find(l => l.startsWith("- mars.time.sol "));
  assert.match(sol, /\[measured\]/); assert.match(sol, new RegExp(`${index.facts["mars.time.sol"].value} s`)); assert.match(sol, /FACT_MARS_TIME_SOL = \d+, fact\(\) returns the value/); assert.match(sol, /NSSDCA/);
  const table = factLines(index, keys).find(l => l.startsWith("- jezero.temperature.my36_air_hourly_mean "));
  assert.match(table, /table of 24 values in K/); assert.match(table, /fact\(\) returns NaN/);
  assert.equal(factKeyName("jezero.temperature.my36_air_hourly_mean"), "FACT_JEZERO_TEMPERATURE_MY36_AIR_HOURLY_MEAN");
  assert.ok(sys.length < 120_000, `prompt is ${sys.length} bytes`);
});

test("parseReply: prose is questions; the three sections are a module, with or without fences", () => {
  assert.deepEqual(parseReply("  " + QUESTIONS + "\n"), { kind: "questions", text: QUESTIONS });
  const r = parseReply(moduleReply(STATION_MANIFEST, STATION_SRC, "done"));
  assert.equal(r.kind, "module");
  assert.deepEqual(JSON.parse(r.manifestText), STATION_MANIFEST);
  assert.equal(r.source, STATION_SRC); assert.equal(r.explanation, "done");
  const bare = parseReply(`${MARKERS[0]}\n{"name":"x","description":"y","version":1,"author":"a"}\n${MARKERS[1]}\nexport function init(): void {}\n${MARKERS[2]}\nok`);
  assert.equal(bare.kind, "module"); assert.equal(bare.source, "export function init(): void {}\n");
});

test("checkModule: manifest errors, unknown and superseded fact ids, foreign imports, missing exports", () => {
  const ok = checkModule(parseReply(moduleReply(STATION_MANIFEST, STATION_SRC)), index);
  assert.deepEqual(ok.problems, []); assert.equal(ok.manifest.name, "weather station");
  const bad = checkModule(parseReply(moduleReply({ ...STATION_MANIFEST, fact_ids: [SUPERSEDED, "mars.no.such_fact"], version: 0 },
    'import { fetch } from "./net";\nimport { read } from "./host";\nexport function init(): void {}\n')), index);
  assert.ok(bad.problems.some(p => p.includes(`"${SUPERSEDED}" is superseded by "${index.facts[SUPERSEDED].superseded_by}"`)), bad.problems.join("|"));
  assert.ok(bad.problems.some(p => p.includes('"mars.no.such_fact" is not in the fact index')));
  assert.ok(bad.problems.some(p => p.includes('refers to "./net"')));
  assert.ok(bad.problems.some(p => p.includes("must export init()")));
  assert.ok(bad.problems.some(p => p.startsWith("manifest: ")), "the runtime manifest check runs too");
  assert.ok(checkModule(parseReply(`${MARKERS[0]}\n{not json\n${MARKERS[1]}\nx\n${MARKERS[2]}\n`), index).problems[0].startsWith("manifest is not valid JSON"));
  assert.equal(slug("Weather Station v2!"), "weather_station_v2"); assert.equal(slug(""), "module"); assert.equal(slug("12 rocks"), "rocks");
});

test("static check: every foreign module specifier form is refused before the compiler runs", async () => {
  const forms = {
    side_effect: 'import "../../outside/victim";', star: 'export * from "../../outside/victim";', named: 'export { read } from "../../outside/victim";',
    default_import: 'import victim from "../../outside/victim";', dynamic: 'const v = import("../../outside/victim");', absolute: 'import { x } from "/etc/hostname";',
    reference: '/// <reference path="../../outside/victim.ts" />', require: 'const v = require("../../outside/victim");',
    comment_between: 'export * from/**/"../../outside/victim";', comment_between2: 'import /* x */ "../../outside/victim";',
    newline_between: 'import { x }\nfrom\n"../../outside/victim";',
  };
  assert.equal(stripComments('const a = "http://x//y"; // from "../z"\nlet b = `t // ${1}`; /* from "../w" */ let c = 2;'), 'const a = "http://x//y"; \nlet b = `t // ${1}`;   let c = 2;');
  assert.deepEqual(moduleSpecifiers('// reads the dust value from "the sky"\nimport { read } from "./host";'), ["./host"], "a comment cannot fake a specifier");
  assert.deepEqual(moduleSpecifiers(STATION_SRC.replace('from "./host"', 'from /* c */ "./host"')), ["./host"], "or hide one");
  assert.deepEqual(moduleSpecifiers(STATION_SRC), ["./host"]);
  assert.deepEqual(moduleSpecifiers('export * from "./host";\nimport "./host";'), ["./host", "./host"]);
  for (const [name, line] of Object.entries(forms)) {
    const src = line + "\n" + STATION_SRC;
    assert.ok(moduleSpecifiers(src).some(s => s !== "./host"), `${name}: specifier seen`);
    let builds = 0; const countingBuild = async () => { builds++; return { ok: true, wasm: new Uint8Array(8), report: "" }; };
    const { llm } = recorded([moduleReply(STATION_MANIFEST, src)]);
    const r = await runWorkshop({ messages: [{ role: "user", content: "x" }], llm, index, keys, tries: 1, build: countingBuild });
    assert.equal(r.type, "failed", name); assert.equal(builds, 0, `${name}: never compiled`);
    assert.match(r.log[0].error, /the only module that exists is "\.\/host"/, name);
  }
});

test("compiler sandbox: even with the static check bypassed, a file outside the temp directory is never read", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "victim-"));
  try {
    const marker = "SECRET_MARKER_" + Math.random().toString(36).slice(2);
    const victim = path.join(dir, "victim.ts");
    writeFileSync(victim, `const leak: i32 = "${marker}";\n`);                 // a type error that would quote this line if the compiler read it
    const rel = path.relative(process.cwd(), victim).replace(/\.ts$/, "");
    const v = victim.replace(/\.ts$/, "");
    for (const [name, line] of [["absolute", `import "${v}";`], ["relative", `import "${rel.startsWith(".") ? rel : "./" + rel}";`], ["star", `export * from "${v}";`],
      ["comment_between", `export * from/**/"${v}";`], ["comment_between2", `import /* x */ "${v}";`]]) {
      const r = await compileAndTest(line + "\n" + STATION_SRC);
      assert.equal(r.ok, false, name);
      assert.match(r.error, /not found/, name);
      assert.ok(!r.error.includes(marker), `${name}: the outside file's content is not in the error`);   // the path itself is echoed: it is the model's own import line
    }
    const c = await compileSource(STATION_SRC);
    assert.ok(c.ok); assert.ok(Buffer.compare(Buffer.from(c.wasm), readFileSync(new URL("build/weather_station.wasm", root))) === 0, "in-memory compile matches build.sh byte for byte");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const FREEZE_SRC = 'import { state_set } from "./host";\n@inline function r(n: i32): i32 { return r(n + 1) + r(n + 2); }\nexport function init(): void {}\nexport function tick(dt: f32): void { state_set(0, <f32>r(0)); }\n';
const manyCalls = n => 'import { state_set } from "./host";\nexport function init(): void {}\n' + Array.from({ length: n }, (_, i) => `function g${i}(): i32 { return ${i}; }`).join("\n") +
  `\nexport function tick(dt: f32): void { let s: i32 = ${Array.from({ length: n }, (_, i) => `g${i}()`).join(" + ")}; state_set(0, <f32>s); }\n`;
const DEEP_SRC = 'import { state_set } from "./host";\nexport function init(): void {}\nexport function tick(dt: f32): void { let s: i32 = ' + "(".repeat(30000) + "1" + ")".repeat(30000) + "; state_set(0, <f32>s); }\n";

test("compiler limits: a source that freezes, crashes or overflows the compiler is a compiler error, and other compiles go on meanwhile", async () => {
  const t0 = Date.now();
  // compileSource, not compileAndTest: the point is that the compiler is not blocked; the smoke test's 2 ms tick budget is a separate, load-sensitive check
  const [frozen, station] = await Promise.all([compileAndTest(FREEZE_SRC, undefined, { timeoutMs: 3000 }), compileSource(STATION_SRC)]);
  const took = Date.now() - t0;
  assert.equal(frozen.ok, false); assert.match(frozen.error, /^COMPILER ERROR:/); assert.match(frozen.error, /did not finish within 3 s/);
  assert.ok(took >= 2900 && took < 15000, `the freeze was cut at the limit (${took} ms)`);
  assert.ok(station.ok, `a compile started beside the frozen one finished normally: ${station.ok ? "" : station.error}`);
  const crashed = await compileAndTest(manyCalls(10000));
  assert.equal(crashed.ok, false); assert.match(crashed.error, /^COMPILER ERROR:/); assert.match(crashed.error, /crashed and stopped|crashed:|ran out of memory/);
  const deep = await compileAndTest(DEEP_SRC);
  assert.equal(deep.ok, false); assert.match(deep.error, /^COMPILER ERROR:/); assert.match(deep.error, /the compiler threw: Maximum call stack size exceeded/);
  const c = await compileSource(STATION_SRC);
  assert.ok(c.ok && Buffer.compare(Buffer.from(c.wasm), readFileSync(new URL("build/weather_station.wasm", root))) === 0, "the compiler still matches build.sh afterwards");
});

test("HTTP: the server answers /health while a compile is frozen, and the request gets a normal failed answer", async () => {
  const { llm } = recorded([moduleReply(STATION_MANIFEST, FREEZE_SRC)]);
  const server = createWorkshopServer({ llm, index, keys, build: src => compileAndTest(src, undefined, { timeoutMs: 3000 }) });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const t0 = Date.now();
    const pending = fetch(base + "/workshop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "x" }], tries: 1 }) });
    await new Promise(r => setTimeout(r, 500));
    const h0 = Date.now(); const health = await fetch(base + "/health"); const hTook = Date.now() - h0;
    assert.equal(health.status, 200); assert.ok(hTook < 2000, `/health answered in ${hTook} ms while the compile was stuck for 3 s`);
    const res = await pending; const json = await res.json();
    assert.equal(res.status, 200); assert.equal(json.type, "failed"); assert.match(json.error, /did not finish within 3 s/);
    assert.ok(Date.now() - t0 < 15000);
  } finally { server.close(); }
});

test("recorded conversation: the agent asks first, then builds the weather station through asc and the smoke test", async () => {
  const { llm, calls } = recorded([QUESTIONS, moduleReply(STATION_MANIFEST, STATION_SRC)]);
  const messages = [{ role: "user", content: "a weather station that raises a flag when it gets really cold" }];
  const first = await runWorkshop({ messages, llm, index, keys });
  assert.equal(first.type, "questions"); assert.equal(first.text, QUESTIONS); assert.equal(first.tries, 1);
  messages.push({ role: "assistant", content: first.text }, { role: "user", content: "1.45 m is fine; -70 C is my threshold" });
  const r = await runWorkshop({ messages, llm, index, keys });
  assert.equal(r.type, "module", JSON.stringify(r).slice(0, 400));
  assert.equal(r.name, "weather_station"); assert.equal(r.tries, 1); assert.equal(r.log.length, 1);
  assert.deepEqual(r.manifest, STATION_MANIFEST); assert.deepEqual(validateManifest(r.manifest), []);
  assert.deepEqual(r.fact_ids, ["jezero.temperature.my36_air_hourly_mean"]);
  const wasm = Buffer.from(r.wasm, "base64");
  assert.ok(wasm.length > 100 && WebAssembly.validate(wasm), "a real module came back");
  assert.equal(memoryPolicy(wasm, MAX_MEMORY_PAGES), null, "it passes the sandbox's resource policy");
  assert.match(r.report, /ok: 600 ticks/);
  assert.match(r.explanation, /jezero\.temperature\.my36_air_hourly_mean/);
  assert.equal(calls.length, 2); assert.equal(calls[1].messages.length, 3); assert.equal(calls[1].system, calls[0].system);
  assert.ok(calls[0].system.includes("## Principle 1"));
});

test("retry loop: a broken first answer is sent back with the compiler output; the second answer passes", async () => {
  const { llm, calls } = recorded([moduleReply(STATION_MANIFEST, BROKEN_SRC), moduleReply(STATION_MANIFEST, STATION_SRC)]);
  const r = await runWorkshop({ messages: [{ role: "user", content: "weather station" }], llm, index, keys });
  assert.equal(r.type, "module"); assert.equal(r.tries, 2);
  assert.equal(r.log.length, 2); assert.equal(r.log[0].ok, false); assert.match(r.log[0].error, /^COMPILER ERROR:/); assert.match(r.log[0].error, /TS2322|not assignable|i32/);
  assert.ok(!r.log[0].error.includes(tmpdir()), "temp paths are not leaked to the model");
  assert.equal(r.log[1].ok, true);
  assert.equal(calls.length, 2); assert.equal(calls[1].messages.length, 3);
  assert.equal(calls[1].messages[1].role, "assistant"); assert.ok(calls[1].messages[1].content.includes("not a number"), "the broken reply is in the conversation");
  assert.equal(calls[1].messages[2].role, "user"); assert.match(calls[1].messages[2].content, /COMPILER ERROR/); assert.match(calls[1].messages[2].content, /Fix the module/);
  assert.ok(MARKERS.every(m => calls[1].messages[2].content.includes(m)));
});

test("retry loop: a module that compiles but does nothing fails the smoke test and is sent back", async () => {
  const { llm, calls } = recorded([moduleReply(STATION_MANIFEST, IDLE_SRC), moduleReply(STATION_MANIFEST, STATION_SRC)]);
  const r = await runWorkshop({ messages: [{ role: "user", content: "weather station" }], llm, index, keys });
  assert.equal(r.type, "module"); assert.equal(r.tries, 2);
  assert.match(r.log[0].error, /^TEST FAILURE:/); assert.match(r.log[0].error, /never called any actuator/);
  assert.match(calls[1].messages[2].content, /never called any actuator/);
});

test("retry loop: bad fact ids are caught before compiling; after the tries run out the result says so", async () => {
  let builds = 0; const countingBuild = async src => { builds++; return compileAndTest(src); };
  const { llm } = recorded([moduleReply({ ...STATION_MANIFEST, fact_ids: [SUPERSEDED], did_you_know: { ...STATION_MANIFEST.did_you_know, fact_id: SUPERSEDED } }, STATION_SRC), moduleReply(STATION_MANIFEST, STATION_SRC)]);
  const r = await runWorkshop({ messages: [{ role: "user", content: "weather station" }], llm, index, keys, build: countingBuild });
  assert.equal(r.type, "module"); assert.equal(r.tries, 2); assert.equal(builds, 1, "the first answer never reached the compiler");
  assert.match(r.log[0].error, /^MODULE CHECK FAILED:/); assert.match(r.log[0].error, /superseded by/);
  const broken = recorded([moduleReply(STATION_MANIFEST, BROKEN_SRC), moduleReply(STATION_MANIFEST, BROKEN_SRC), moduleReply(STATION_MANIFEST, BROKEN_SRC)]);
  const failedBuild = async () => ({ ok: false, error: "COMPILER ERROR:\nstill broken" });
  const f = await runWorkshop({ messages: [{ role: "user", content: "weather station" }], llm: broken.llm, index, keys, build: failedBuild });
  assert.equal(f.type, "failed"); assert.equal(f.tries, 3); assert.equal(f.log.length, 3); assert.match(f.error, /still broken/);
  assert.equal(broken.calls.length, 3); assert.equal(broken.calls[2].messages.length, 5);
  const one = recorded([moduleReply(STATION_MANIFEST, BROKEN_SRC)]);
  assert.equal((await runWorkshop({ messages: [{ role: "user", content: "x" }], llm: one.llm, index, keys, tries: 1, build: failedBuild })).type, "failed");
  assert.equal(one.calls.length, 1);
});

test("parseConversation: shape and bounds of what the page may send", () => {
  assert.deepEqual(parseConversation({ messages: [{ role: "user", content: "hi" }] }), { messages: [{ role: "user", content: "hi" }], tries: 3 });
  assert.equal(parseConversation({ messages: [{ role: "user", content: "hi" }], tries: 2 }).tries, 2);
  for (const [body, re] of [[null, /JSON object/], [{}, /non-empty array/], [{ messages: [] }, /non-empty array/], [{ messages: [{ role: "system", content: "x" }] }, /role must be/],
    [{ messages: [{ role: "user", content: "" }] }, /non-empty string/], [{ messages: [{ role: "assistant", content: "x" }] }, /first message must be from the user/],
    [{ messages: [{ role: "user", content: "x" }], tries: 9 }, /tries must be/], [{ messages: Array.from({ length: 41 }, () => ({ role: "user", content: "x" })) }, /at most 40/]]) {
    assert.throws(() => parseConversation(body), re);
  }
});

test("HTTP: only local pages may call the server; wrong host, origin or content type are refused before the model is called", async () => {
  for (const o of ["http://localhost", "http://localhost:8000", "http://127.0.0.1:5173", "http://[::1]:3000"]) assert.ok(originAllowed(o), o);
  for (const o of ["https://localhost", "http://evil.example", "http://localhost.evil.example", "null", "http://localhost:8000/x"]) assert.ok(!originAllowed(o), o);
  assert.ok(originAllowed("https://sandbox.example", ["https://sandbox.example"]));
  for (const h of ["localhost", "localhost:8787", "127.0.0.1:8787", "[::1]:8787"]) assert.ok(hostAllowed(h), h);
  for (const h of ["evil.example:8787", "localhost.evil.example", ""]) assert.ok(!hostAllowed(h), h);
  assert.ok(hostAllowed("mars.local:8787", ["mars.local:8787"]));
  const { llm, calls } = recorded([QUESTIONS, QUESTIONS, QUESTIONS]);
  const server = createWorkshopServer({ llm, index, keys, build: fakeBuild, origins: ["https://sandbox.example"] });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  const body = JSON.stringify({ messages: [{ role: "user", content: "a dust gauge" }] });
  try {
    const post = (headers, b = body) => raw(port, "POST", "/workshop", { "content-type": "application/json", ...headers }, b);
    let res = await post({ origin: "https://evil.example" }); assert.equal(res.status, 403); assert.match(res.json.error, /may not use the workshop/);
    assert.equal(res.headers["access-control-allow-origin"], undefined);
    res = await raw(port, "OPTIONS", "/workshop", { origin: "https://evil.example" }); assert.equal(res.status, 403);
    res = await post({ origin: "https://evil.example", "content-type": "text/plain" }); assert.equal(res.status, 403, "a simple request without preflight is refused too");
    res = await post({ host: `evil.example:${port}` }); assert.equal(res.status, 403); assert.match(res.json.error, /not served/);
    res = await post({ "content-type": "text/plain" }); assert.equal(res.status, 415);
    res = await raw(port, "POST", "/workshop", {}, body); assert.equal(res.status, 415, "no content type at all");
    assert.equal(calls.length, 0, "the model was never called");
    res = await post({ origin: "http://localhost:8000" }); assert.equal(res.status, 200);
    assert.equal(res.headers["access-control-allow-origin"], "http://localhost:8000"); assert.equal(res.headers["vary"], "origin");
    res = await post({ origin: "https://sandbox.example" }); assert.equal(res.status, 200); assert.equal(res.headers["access-control-allow-origin"], "https://sandbox.example");
    res = await post({ "content-type": "application/json; charset=utf-8" }); assert.equal(res.status, 200, "a charset parameter is fine");
    assert.equal(calls.length, 3);
    res = await raw(port, "OPTIONS", "/workshop", { origin: "http://localhost:8000" }); assert.equal(res.status, 204); assert.equal(res.headers["access-control-allow-origin"], "http://localhost:8000");
    res = await raw(port, "GET", "/health", { origin: "http://localhost:8000" }); assert.equal(res.status, 200); assert.equal(res.headers["access-control-allow-origin"], "http://localhost:8000");
    const huge = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(1_100_000) }] });
    res = await post({}, huge);
    assert.equal(res.status, 413); assert.match(res.json.error, /body over/);
    assert.equal(calls.length, 3, "the oversize body never reached the model");
  } finally { server.close(); }
});

test("HTTP: POST /workshop answers with questions or a module; bad requests are 400; health and 404", async () => {
  const { llm } = recorded([QUESTIONS, moduleReply(STATION_MANIFEST, STATION_SRC)]);
  const server = createWorkshopServer({ llm, index, keys, build: fakeBuild });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (body, raw = false) => fetch(base + "/workshop", { method: "POST", headers: { "content-type": "application/json" }, body: raw ? body : JSON.stringify(body) });
    let res = await post({ messages: [{ role: "user", content: "a dust gauge" }] });
    assert.equal(res.status, 200); assert.equal(res.headers.get("access-control-allow-origin"), null, "no Origin sent, no CORS header");
    let json = await res.json(); assert.equal(json.type, "questions"); assert.equal(json.text, QUESTIONS);
    res = await post({ messages: [{ role: "user", content: "a dust gauge" }, { role: "assistant", content: QUESTIONS }, { role: "user", content: "1.45 m" }] });
    json = await res.json(); assert.equal(res.status, 200); assert.equal(json.type, "module"); assert.equal(json.name, "weather_station"); assert.equal(json.report, "fake build");
    assert.equal(Buffer.from(json.wasm, "base64").length, 8);
    res = await post("{not json", true); assert.equal(res.status, 400); assert.match((await res.json()).error, /not valid JSON/);
    res = await post({ messages: [] }); assert.equal(res.status, 400);
    res = await fetch(base + "/health"); assert.equal(res.status, 200); json = await res.json(); assert.equal(json.ok, true); assert.equal(json.facts, liveFactIds(index).length);
    res = await fetch(base + "/nope"); assert.equal(res.status, 404);
    res = await post({ messages: [{ role: "user", content: "x" }] }); assert.equal(res.status, 500, "the recorded script is exhausted by now");
    res = await fetch(base + "/workshop?x=1", { method: "GET" }); assert.equal(res.status, 405, "the query string is not part of the path");
    res = await fetch(base + "/workshop"); assert.equal(res.status, 405);
    res = await fetch(base + "/workshop", { method: "OPTIONS" }); assert.equal(res.status, 204);
    const failing = createWorkshopServer({ llm: async () => { throw new Error("script exhausted"); }, index, keys, build: fakeBuild });
    await new Promise(r => failing.listen(0, "127.0.0.1", r));
    try {
      res = await fetch(`http://127.0.0.1:${failing.address().port}/workshop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }) });
      assert.equal(res.status, 500); assert.match((await res.json()).error, /script exhausted/);
    } finally { failing.close(); }
  } finally { server.close(); }
});

test("check:secrets: finds key shapes built at run time, passes on this repo, flags a tracked .env", () => {
  const fake = ["sk-ant-" + "a".repeat(40), "AKIA" + "Q".repeat(16), "ghp_" + "z".repeat(36), "ANTHROPIC_API_KEY=" + "k".repeat(24), ["-----BEGIN", "RSA PRIVATE", "KEY-----"].join(" "),
    "sk-proj-" + "Ab_-".repeat(8), 'api_key = "' + "q".repeat(20) + '"', "openai_api_key: " + "w".repeat(32)];   // every fixture is built at run time so the scanner does not flag this file
  const hits = scanText(["const a = 1;", ...fake, "ANTHROPIC_API_KEY=", "WORKSHOP_MODEL=", "const token = readTokenFromEnvironment();", "apiKey = process.env.ANTHROPIC_API_KEY,"].join("\n"));
  assert.equal(hits.length, fake.length, JSON.stringify(hits));
  assert.deepEqual(hits.map(h => h.line), [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(hits.every(h => h.sample.length <= 15), "samples are truncated");
  const repo = scanRepo(new URL(".", root).pathname.replace(/\/$/, ""));
  assert.deepEqual(repo.findings, []); assert.ok(repo.files > 50);
  const dir = mkdtempSync(path.join(tmpdir(), "secrets-"));
  try {
    execFileSync("git", ["init", "-q", dir]);
    writeFileSync(path.join(dir, ".env"), "ANTHROPIC_API_KEY=\n"); writeFileSync(path.join(dir, "notes.md"), "token: " + fake[0] + "\n");
    execFileSync("git", ["-C", dir, "add", ".env", "notes.md"]);
    const bad = scanRepo(dir);
    assert.ok(bad.findings.some(f => f.file === ".env" && /tracked/.test(f.what)));
    assert.ok(bad.findings.some(f => f.file === "notes.md" && f.what === "Anthropic API key"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

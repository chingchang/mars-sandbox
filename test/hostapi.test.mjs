// X1: the generic host API, manifests and the memory ceiling, exercised through
// the real registry and real workers with the hand-written samples.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { Registry, nodeSpawner, SENSOR_COUNT, MAX_SHAPES, MAX_MEMORY_PAGES } from "../runtime/registry.mjs";
import { buildFactTable } from "../runtime/facts.mjs";
import { validateManifest } from "../runtime/manifest.mjs";
import { memoryLimits, memoryPolicy } from "../runtime/wasm_limits.mjs";

const read = p => readFileSync(new URL(p, import.meta.url));
const wasm = name => read(`../build/${name}.wasm`);
const INDEX = JSON.parse(read("../facts/index.json"));
const KEYS = JSON.parse(read("../runtime/fact_keys.json"));
const SCHEMA = JSON.parse(read("../runtime/manifest.schema.json"));
const STATION_MANIFEST = JSON.parse(read("../behaviors/weather_station.manifest.json"));
const facts = buildFactTable(INDEX, KEYS);
const spawn = await nodeSpawner(new URL("../runtime/worker.mjs", import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SOL = INDEX.facts["mars.time.sol"].value;

const registries = [];
after(() => { for (const reg of registries) for (const o of reg.list()) if (o.module) reg.unload(o.id, "test teardown"); });

/** Synthetic terrain: height = 0.1 * x (east) on a 16 m grid, ±80 m; entities from the registry's objects. */
function makeWorld() {
  const n = 11, res = 16, c = 5, data = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) data[r * n + col] = 0.1 * (col - c) * res;
  const events = [];
  const reg = new Registry({ spawnWorker: spawn, onEvent: ev => events.push(ev), facts,
    world: { terrain: { n, res, cx: c, cz: c, data }, entities: () => Float32Array.from(reg.list().flatMap(o => [o.kind === "rover" ? 0 : 3, o.position.x, o.position.z, o.index])) } });
  registries.push(reg);
  const t = { value: 0 };
  const sensorsFor = o => { const s = new Float32Array(SENSOR_COUNT); s[0] = o.position.x; s[1] = o.position.z; s[2] = o.position.yaw; s[6] = t.value; s[10] = 99; s[12] = 99; return s; };
  const run = async (steps, dtSim = 0.05, pause = 25) => { for (let i = 0; i < steps; i++) { reg.tick(performance.now(), sensorsFor); t.value += dtSim; await sleep(pause); } };
  return { reg, events, run, t };
}

test("weather station: two shapes, two state slots from facts, an hourly signal, tier reported", async () => {
  const { reg, events, run } = makeWorld();
  reg.add({ id: "ws", position: { x: 10, z: 0 } });
  await reg.load("ws", { name: "weather_station", bytes: wasm("weather_station"), manifest: STATION_MANIFEST, logNames: { 30: "hour", 31: "tier" } });
  assert.equal(reg.get("ws").manifest.name, "weather station");
  const spawns = events.filter(e => e.type === "spawn" && e.id === "ws");
  assert.equal(spawns.length, 2); assert.deepEqual(spawns.map(s => s.spec.shape), [1, 4]);
  assert.equal(reg.get("ws").shapes.size, 2);
  assert.ok(events.some(e => e.type === "pose" && e.handle === 0 && Math.abs(e.pose.y - 1.0) < 1e-6));
  const tier = events.find(e => e.type === "log" && e.id === "ws" && /tier/.test(e.text));
  assert.match(tier.text, /tier 1\.00/, "the MY36 annual mean is measured (rank 1)");
  await run(6, SOL / 24 + 1);                                          // each tick advances one Mars hour
  const slots = reg.get("ws").state;
  assert.ok(Math.abs(slots[1] - INDEX.facts["jezero.temperature.my36_air_annual_mean"].value) < 1e-3, `slot 1 = fact value, got ${slots[1]}`);
  assert.ok(slots[0] > 0.2 && slots[0] < 0.3, `sols elapsed ${slots[0]}`);
  const pulses = events.filter(e => e.type === "signal" && e.id === "ws" && e.code === 100);
  assert.ok(pulses.length >= 5, `hour pulses ${pulses.length}`);
  assert.ok(reg.nextSignals.has(100) || reg.signals.has(100), "the last pulse is queued for the next tick");
});

test("beacon: nearest(rover), terrain_height, signal_read across objects, re-spawn on state change", async () => {
  const { reg, events, run } = makeWorld();
  const rover = reg.add({ id: "rover", kind: "rover", position: { x: 0, z: 0 } });    // no module: the world moves it
  reg.add({ id: "beacon", position: { x: 30, z: 0 } });
  reg.add({ id: "ws", position: { x: -20, z: 0 } });
  await reg.load("beacon", { name: "beacon", bytes: wasm("beacon"), logNames: { 50: "lit" } });
  await reg.load("ws", { name: "weather_station", bytes: wasm("weather_station") });
  await run(4);
  const b = reg.get("beacon");
  assert.ok(Math.abs(b.state[0] - 30) < 1e-3, `distance to rover ${b.state[0]}`);
  assert.equal(b.state[1], 0, "dark at 30 m");
  assert.ok(Math.abs(b.state[3] - 3.0) < 1e-3, `terrain height at x=30 is 3.0, got ${b.state[3]}`);
  rover.position.x = 15;                                               // the rover drives closer
  await run(4);
  assert.ok(Math.abs(b.state[0] - 15) < 1e-3); assert.equal(b.state[1], 1, "lit at 15 m");
  assert.ok(events.some(e => e.type === "log" && e.id === "beacon" && /lit 1\.00/.test(e.text)));
  const redSpawn = events.filter(e => e.type === "spawn" && e.id === "beacon").at(-1);
  assert.equal(redSpawn.spec.r, 1, "re-spawned red");
  // signal_read: the station's hourly pulse (code 100) reaches the beacon on the following tick
  await run(3, SOL / 24 + 1);
  assert.ok(b.state[2] >= 1, `beacon heard hour ${b.state[2]}`);
  // a beacon never asks the rover to drive: no drive requests from it
  assert.ok(events.filter(e => e.type === "actions" && e.id === "beacon").every(e => e.actions.throttle === 0));
});

test("handles are per object and capped at 32; unknown handles are ignored (scripted worker)", async () => {
  // a fake worker that replies with whatever actions the test scripts, independent of Wasm
  const scripts = new Map();
  const fakeSpawner = () => { let handler = null, name = null; return {
    post(m) { if (m.type === "load") { name = new TextDecoder().decode(m.bytes); setTimeout(() => handler({ type: "loaded", imports: [], actions: scripts.get(name).load }), 0); }
              else if (m.type === "tick") setTimeout(() => handler({ type: "actions", actions: { ...scripts.get(name).tick, ms: 0.01, memBytes: 65536 } }), 0); },
    onMessage(fn) { handler = fn; }, terminate() {} }; };
  const blank = () => ({ throttle: 0, steer: 0, arm: null, led: null, logs: [], mem: [], spawn: [], pose: [], remove: [], state: [], signals: [] });
  const many = Array.from({ length: 40 }, (_, i) => [i, 0, 1, 1, 1, 0.5, 0.5, 0.5]);
  scripts.set("A", { load: { ...blank(), spawn: many }, tick: { ...blank(), pose: [[5, 1, 2, 3, 0, 0], [39, 9, 9, 9, 0, 0], [7, 0, 0, 0, 0, 0]], remove: [38] } });
  scripts.set("B", { load: { ...blank(), spawn: [[5, 2, 1, 1, 1, 1, 0, 0]] }, tick: { ...blank(), pose: [[5, 7, 7, 7, 0, 0]] } });
  const events = [];
  const reg = new Registry({ spawnWorker: fakeSpawner, onEvent: ev => events.push(ev) });
  reg.add({ id: "a" }); reg.add({ id: "b" });
  await reg.load("a", { name: "A", bytes: new TextEncoder().encode("A") });
  await reg.load("b", { name: "B", bytes: new TextEncoder().encode("B") });
  assert.equal(reg.get("a").shapes.size, MAX_SHAPES, "capped at 32 even if a worker claims more");
  assert.equal(reg.get("b").shapes.size, 1);
  reg.tick(0, () => new Float32Array(SENSOR_COUNT)); await sleep(20);
  assert.deepEqual(reg.get("a").shapes.get(5).pose, { x: 1, y: 2, z: 3, yaw: 0, pitch: 0 });
  assert.deepEqual(reg.get("b").shapes.get(5).pose, { x: 7, y: 7, z: 7, yaw: 0, pitch: 0 }, "B's handle 5 is B's own shape");
  assert.ok(!events.some(e => e.type === "pose" && e.id === "a" && e.handle === 39), "handle 39 was never spawned (cap) so its pose is ignored");
  assert.ok(reg.get("a").shapes.has(7) && !events.some(e => e.type === "remove" && e.id === "a" && e.handle === 38 && reg.get("a").shapes.has(38)));
  reg.unload("a");
  assert.equal(reg.get("a").shapes.size, 0, "unload removes all shapes");
  assert.equal(events.filter(e => e.type === "remove" && e.id === "a").length >= MAX_SHAPES, true);
  assert.equal(reg.get("b").shapes.size, 1, "unloading a leaves b's shapes");
  reg.unload("b");
});

test("memory ceiling: memhog is capped at 256 pages and keeps running; a module with no maximum is rejected", async () => {
  const { reg, events, run } = makeWorld();
  reg.add({ id: "m" });
  await reg.load("m", { name: "memhog", bytes: wasm("memhog"), logNames: { 40: "pages", 41: "failed grows" } });
  await run(300, 0.05, 2);
  const st = reg.stats("m");
  assert.ok(st.enabled, "still running");
  assert.ok(st.memBytes <= MAX_MEMORY_PAGES * 65536, `memory ${st.memBytes} within ceiling`);
  assert.ok(st.memBytes >= 200 * 65536, `memory actually grew (${st.memBytes})`);
  const failed = events.filter(e => e.type === "log" && e.id === "m" && /failed grows/.test(e.text)).at(-1);
  assert.match(failed.text, /failed grows [1-9]/, "grow fails once the maximum is reached");
  reg.unload("m");
  // no declared maximum: hand-assembled module with a memory section (min 1, no max) and init/tick exports
  const NOMAX = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 3, 3, 2, 0, 0, 5, 3, 1, 0, 1,
    7, 15, 2, 4, 0x69, 0x6e, 0x69, 0x74, 0, 0, 4, 0x74, 0x69, 0x63, 0x6b, 0, 1, 10, 7, 2, 2, 0, 0x0b, 2, 0, 0x0b]);
  assert.deepEqual(memoryLimits(NOMAX), [{ min: 1, max: null, imported: false, flag: 0 }]);
  assert.equal(memoryLimits(wasm("patrol"))[0].max, 256);
  assert.equal(memoryLimits(wasm("memhog"))[0].max, 256);
  reg.add({ id: "n" });
  await assert.rejects(reg.load("n", { name: "nomax", bytes: NOMAX }), /declares no maximum memory/);
});

// the same skeleton with other memory sections: a bounded first memory plus a second one
const withMemorySection = (...mem) => Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 3, 3, 2, 0, 0, 5, mem.length, ...mem,
  7, 15, 2, 4, 0x69, 0x6e, 0x69, 0x74, 0, 0, 4, 0x74, 0x69, 0x63, 0x6b, 0, 1, 10, 7, 2, 2, 0, 0x0b, 2, 0, 0x0b]);
const TWO_MEM_UNBOUNDED = withMemorySection(2, 1, 1, 1, 0, 1);                 // (memory 1 1) (memory 1)
const TWO_MEM_HUGE = withMemorySection(2, 1, 1, 1, 1, 1, 0x80, 0x80, 0x04);    // (memory 1 1) (memory 1 65536)
const MEMORY64 = withMemorySection(1, 4, 1);                                   // (memory i64 1)

test("memory policy covers every memory: a second memory, bounded or not, and memory64 are rejected", async () => {
  assert.equal(memoryLimits(TWO_MEM_UNBOUNDED).length, 2);
  assert.deepEqual(memoryLimits(TWO_MEM_HUGE)[1], { min: 1, max: 65536, imported: false, flag: 1 });
  assert.match(memoryPolicy(TWO_MEM_UNBOUNDED, MAX_MEMORY_PAGES), /declares 2 memories/);
  assert.match(memoryPolicy(TWO_MEM_HUGE, MAX_MEMORY_PAGES), /declares 2 memories/);
  assert.throws(() => memoryLimits(MEMORY64), /memory64 is not allowed/);
  assert.match(memoryPolicy(MEMORY64, MAX_MEMORY_PAGES), /memory64/);
  assert.equal(memoryPolicy(wasm("patrol"), MAX_MEMORY_PAGES), null);
  assert.equal(memoryPolicy(EVIL_NO_MEMORY, MAX_MEMORY_PAGES), null, "a module with no memory has nothing to grow");
  const { reg } = makeWorld();
  for (const [name, bytes, re] of [["two_unbounded", TWO_MEM_UNBOUNDED, /declares 2 memories/], ["two_huge", TWO_MEM_HUGE, /declares 2 memories/], ["mem64", MEMORY64, /memory64/]]) {
    reg.add({ id: name });
    await assert.rejects(reg.load(name, { name, bytes }), re);
    assert.equal(reg.enabled(name), false);
  }
});
const EVIL_NO_MEMORY = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 3, 3, 2, 0, 0,
  7, 15, 2, 4, 0x69, 0x6e, 0x69, 0x74, 0, 0, 4, 0x74, 0x69, 0x63, 0x6b, 0, 1, 10, 7, 2, 2, 0, 0x0b, 2, 0, 0x0b]);

test("handles are reused: 100 spawn/remove cycles never fail and hold at most one live shape", async () => {
  const { reg, events, run } = makeWorld();
  reg.add({ id: "c" });
  await reg.load("c", { name: "churn", bytes: wasm("churn"), logNames: { 60: "handle" } });
  await run(100, 0.05, 5);
  const handles = events.filter(e => e.type === "actions" && e.id === "c").flatMap(e => e.actions.logs.filter(([c]) => c === 60).map(([, v]) => v));
  assert.ok(handles.length >= 100, `${handles.length} spawns`);
  assert.ok(handles.every(h => h >= 0 && h < 2), `handles alternate between 0 and 1, never -1: ${[...new Set(handles)].join(",")}`);
  assert.ok(handles.includes(0) && handles.includes(1), "the freed handle is reused on the following tick");
  assert.equal(reg.get("c").shapes.size, 1);
  assert.ok(events.filter(e => e.type === "remove" && e.id === "c").length >= 99);
  reg.unload("c");
});

test("beacon: ten toggles leave exactly one lamp whose colour matches the lit state", async () => {
  const { reg, events, run } = makeWorld();
  const rover = reg.add({ id: "rover", kind: "rover", position: { x: 0, z: 0 } });
  reg.add({ id: "beacon", position: { x: 30, z: 0 } });
  await reg.load("beacon", { name: "beacon", bytes: wasm("beacon") });
  for (let i = 0; i < 10; i++) {
    rover.position.x = i % 2 === 0 ? 15 : 0;                      // 15 m (in range), 30 m (out of range), ...
    await run(6, 0.05, 30);                                        // enough real time for every tick to complete
    const b = reg.get("beacon");
    assert.equal(b.shapes.size, 1, `toggle ${i}: one lamp`);
    const lamp = [...b.shapes.values()][0];
    const lit = i % 2 === 0;
    assert.equal(b.state[1], lit ? 1 : 0);
    assert.equal(lamp.r === 1, lit, `toggle ${i}: lamp colour matches lit=${lit}`);
  }
  assert.ok(events.filter(e => e.type === "remove" && e.id === "beacon").length >= 10);
  reg.unload("beacon");
});

test("did_you_know must name a fact id that is also in fact_ids", () => {
  assert.deepEqual(validateManifest(STATION_MANIFEST), []);
  assert.ok(validateManifest({ ...STATION_MANIFEST, did_you_know: "a free string" }).length > 0);
  assert.ok(validateManifest({ ...STATION_MANIFEST, did_you_know: { text: "x", fact_id: "mars.time.sol" }, fact_ids: ["jezero.temperature.my36_air_annual_mean"] }).some(e => /also be listed/.test(e)));
});

test("manifest: the sample validates with ajv and the runtime check; bad manifests fail both consistently", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(SCHEMA);
  assert.ok(validate(STATION_MANIFEST), JSON.stringify(validate.errors));
  assert.deepEqual(validateManifest(STATION_MANIFEST), []);
  const bad = [
    { ...STATION_MANIFEST, extra: 1 },
    { ...STATION_MANIFEST, state: [{ slot: 16, label: "x" }] },
    { ...STATION_MANIFEST, fact_ids: ["not an id"] },
    (() => { const m = { ...STATION_MANIFEST }; delete m.author; return m; })(),
    { ...STATION_MANIFEST, version: 0 },
    { ...STATION_MANIFEST, signals: { emits: [{ code: 70000, label: "x" }] } },
    { ...STATION_MANIFEST, shapes: 33 },
    { ...STATION_MANIFEST, did_you_know: "a free string" },
    { ...STATION_MANIFEST, did_you_know: { text: "x" } },
  ];
  for (const m of bad) { assert.equal(validate(m), false, JSON.stringify(m).slice(0, 80)); assert.ok(validateManifest(m).length > 0, JSON.stringify(m).slice(0, 80)); }
});

test("registry rejects a load with a bad manifest and keeps the old module", async () => {
  const { reg, run } = makeWorld();
  reg.add({ id: "x" });
  await reg.load("x", { name: "patrol", bytes: wasm("patrol") });
  await assert.rejects(reg.load("x", { name: "beacon", bytes: wasm("beacon"), manifest: { name: "b" } }), /bad manifest/);
  assert.equal(reg.stats("x").name, "patrol");
  await run(2);
  reg.unload("x");
});

test("sanitizeActions validates the generic fields", () => {
  const { actions, bad } = Registry.sanitizeActions({ throttle: 0, steer: 0, arm: null, led: null, logs: [], mem: [],
    spawn: [[0, 1, 1, 2, 3, 0.5, 0.5, 0.5], [40, 1, 1, 1, 1, 0, 0, 0], [1, 9, 1, 1, 1, 0, 0, 0], [2, 2, 100, 0.001, 1, 2, -1, 0.5]],
    pose: [[0, 1, 2, 3, 0, 0], [0, NaN, 0, 0, 0, 0], [-1, 0, 0, 0, 0, 0]], remove: [0, 32], state: [[15, 1], [16, 1], [0, Infinity]],
    signals: [[100, 1], [70000, 1], [1, NaN]], ms: 0.1, memBytes: 65536 });
  assert.deepEqual(actions.spawn, [[0, 1, 1, 2, 3, 0.5, 0.5, 0.5], [2, 2, 50, 0.01, 1, 1, 0, 0.5]]);
  assert.deepEqual(actions.pose, [[0, 1, 2, 3, 0, 0]]); assert.deepEqual(actions.remove, [0]);
  assert.deepEqual(actions.state, [[15, 1]]); assert.deepEqual(actions.signals, [[100, 1]]);
  assert.equal(actions.memBytes, 65536); assert.equal(bad, 9);
});

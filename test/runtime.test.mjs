// runtime/registry.mjs (task R1): three objects with three modules run
// together; a hung module is terminated while the others keep ticking;
// replacing one object's module leaves the others' state untouched; an illegal
// import is rejected before instantiation; a failed replacement keeps the old
// module running.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Registry, nodeSpawner, WATCHDOG_MS, SENSOR_COUNT } from "../runtime/registry.mjs";

const wasm = name => readFileSync(new URL(`../build/${name}.wasm`, import.meta.url));
const spawn = await nodeSpawner(new URL("../runtime/worker.mjs", import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const K = { POS_X: 0, POS_Z: 1, HEADING: 2, TIME: 6, CHARGER_DIST: 7, OBSTACLE_DIST: 10, TARGET_DIST: 12 };

const registries = [];
after(() => { for (const reg of registries) for (const o of reg.list()) if (o.module) reg.unload(o.id, "test teardown"); });   // a live worker keeps the process alive

/** A toy world: each object has x, z, heading driven by its module's throttle/steer. */
function makeWorld() {
  const events = [];
  const reg = new Registry({ spawnWorker: spawn, onEvent: ev => events.push(ev) });
  registries.push(reg);
  const t = { value: 0 };
  const sensorsFor = o => { const s = new Float32Array(SENSOR_COUNT); s[K.POS_X] = o.position.x; s[K.POS_Z] = o.position.z; s[K.HEADING] = o.position.yaw; s[K.TIME] = t.value; s[K.CHARGER_DIST] = 15; s[K.OBSTACLE_DIST] = 99; s[K.TARGET_DIST] = 99; return s; };
  reg.onEvent = ev => { events.push(ev); if (ev.type === "actions") { const o = ev.object, a = ev.actions; o.position.yaw += a.steer * 1.2 * 0.05; o.position.x += Math.sin(o.position.yaw) * a.throttle * 2 * 0.05; o.position.z += Math.cos(o.position.yaw) * a.throttle * 2 * 0.05; } };
  // run the scheduler for `steps` real ticks of ~25 ms, advancing the module clock by dtSim each
  const run = async (steps, dtSim = 0.05) => { for (let i = 0; i < steps; i++) { reg.tick(performance.now(), sensorsFor); t.value += dtSim; await sleep(25); } };
  return { reg, events, run, t, sensorsFor };
}

/** Hand-assembled wasm: imports host.evil, exports init and tick. 45 bytes. */
const EVIL = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
  1, 4, 1, 0x60, 0, 0,                                              // type: () -> ()
  2, 13, 1, 4, 0x68, 0x6f, 0x73, 0x74, 4, 0x65, 0x76, 0x69, 0x6c, 0, 0, // import host.evil : type 0
  3, 3, 2, 0, 0,                                                    // two functions of type 0
  7, 15, 2, 4, 0x69, 0x6e, 0x69, 0x74, 0, 1, 4, 0x74, 0x69, 0x63, 0x6b, 0, 2, // exports init=f1 tick=f2
  10, 7, 2, 2, 0, 0x0b, 2, 0, 0x0b]);                               // empty bodies

test("three objects with three modules tick together, each with its own state", async () => {
  const { reg, events, run } = makeWorld();
  reg.add({ id: "rover", owner: "player", kind: "rover" });
  reg.add({ id: "beacon", owner: "alice", position: { x: 40, z: 0 } });
  reg.add({ id: "scout", owner: "bob", position: { x: -40, z: 10 } });
  await reg.load("rover", { name: "patrol", bytes: wasm("patrol") });
  await reg.load("beacon", { name: "seek_target", bytes: wasm("seek_target") });
  await reg.load("scout", { name: "patrol", bytes: wasm("patrol") });
  assert.ok(reg.enabled("rover") && reg.enabled("beacon") && reg.enabled("scout"));
  await run(40);
  for (const id of ["rover", "beacon", "scout"]) assert.ok(reg.stats(id).ticks >= 30, `${id} ticked ${reg.stats(id).ticks}`);
  const rover = reg.get("rover"), scout = reg.get("scout"), beacon = reg.get("beacon");
  assert.ok(Math.hypot(rover.position.x, rover.position.z) > 1, "patrol moved the rover");
  assert.ok(Math.hypot(scout.position.x + 40, scout.position.z - 10) > 1, "patrol moved the scout from its own origin");
  assert.ok(Math.abs(beacon.position.x - 40) < 1e-6 && Math.abs(beacon.position.z) < 1e-6, "seek_target with no target does not move");
  assert.ok(events.some(e => e.type === "log" && e.id === "rover" && /is live on "rover"/.test(e.text)));
  for (const id of ["rover", "beacon", "scout"]) reg.unload(id);
});

test("a hung module is killed by the watchdog; the other two keep ticking", async () => {
  const { reg, events, run } = makeWorld();
  reg.add({ id: "a" }); reg.add({ id: "b" }); reg.add({ id: "c" });
  await reg.load("a", { name: "patrol", bytes: wasm("patrol") });
  await reg.load("b", { name: "runaway", bytes: wasm("runaway") });
  await reg.load("c", { name: "seek_target", bytes: wasm("seek_target") });
  await run(20, 0.5);                                 // runaway hangs after 3 s of module time (6 ticks)
  const tA0 = reg.stats("a").ticks, tC0 = reg.stats("c").ticks;
  // the watchdog needs WATCHDOG_MS of real time after the hung tick was sent
  await run(Math.ceil(WATCHDOG_MS / 25) + 4, 0.05);
  assert.equal(reg.enabled("b"), false, "runaway killed");
  assert.ok(events.some(e => e.type === "unloaded" && e.id === "b" && e.reason === "killed by watchdog"), "reason recorded");
  assert.ok(events.some(e => e.type === "log" && e.id === "b" && /watchdog/.test(e.text)));
  assert.ok(reg.enabled("a") && reg.enabled("c"), "others still enabled");
  await run(10);
  assert.ok(reg.stats("a").ticks > tA0 + 5 && reg.stats("c").ticks > tC0 + 5, "others kept ticking after the kill");
  // the hung tick never returns, so its log(99) never reaches the host: a hang is silent by construction
  assert.ok(!reg.get("b").lastActions?.logs?.some(([c]) => c === 99), "no actions arrive from a tick that never returned");
  reg.unload("a"); reg.unload("c");
});

test("replacing one object's module leaves the others' position and memory untouched", async () => {
  const { reg, run } = makeWorld();
  reg.add({ id: "r1" }); reg.add({ id: "r2", position: { x: 20, z: 20 } });
  await reg.load("r1", { name: "patrol", bytes: wasm("patrol") });
  await reg.load("r2", { name: "patrol", bytes: wasm("patrol") });
  await run(30);
  const r2 = reg.get("r2");
  const pos = { ...r2.position }, mem = Float32Array.from(r2.mem), ticks = reg.stats("r2").ticks;
  const r1mem0 = reg.get("r1").mem[0];
  await reg.load("r1", { name: "seek_target", bytes: wasm("seek_target") });   // hot swap on r1 only
  assert.equal(reg.stats("r1").name, "seek_target"); assert.equal(reg.stats("r1").ticks, 0);
  assert.deepEqual({ ...r2.position }, pos, "r2 position unchanged by r1's swap");
  assert.deepEqual(Float32Array.from(r2.mem), mem, "r2 memory unchanged by r1's swap");
  assert.equal(reg.stats("r2").ticks, ticks); assert.equal(reg.stats("r2").name, "patrol");
  assert.equal(reg.get("r1").mem[0], r1mem0, "r1's host memory survives its own reload (v2 inherits v1 state)");
  await run(10);
  assert.ok(reg.stats("r2").ticks > ticks && reg.stats("r1").ticks > 5, "both tick after the swap");
  reg.unload("r1"); reg.unload("r2");
});

test("an illegal import is rejected before instantiation and keeps the old module running", async () => {
  const { reg, events, run } = makeWorld();
  reg.add({ id: "x" });
  await reg.load("x", { name: "patrol", bytes: wasm("patrol") });
  await run(5);
  const before = reg.stats("x").ticks;
  await assert.rejects(reg.load("x", { name: "evil", bytes: EVIL }), /illegal import host\.evil/);
  assert.equal(reg.stats("x").name, "patrol"); assert.ok(reg.enabled("x"));
  await run(5);
  assert.ok(reg.stats("x").ticks > before, "old module kept ticking through the rejected replacement");
  assert.ok(events.some(e => e.type === "log" && /rejected "evil": illegal import host\.evil/.test(e.text)));
  reg.unload("x");
});

test("non-finite values from a hostile module never reach the host: zeroed or dropped, memory untouched, reported once", async () => {
  const { reg, events, run } = makeWorld();
  reg.add({ id: "h" });
  const memBefore = Float32Array.from(reg.get("h").mem);
  await reg.load("h", { name: "nonfinite", bytes: wasm("nonfinite") });
  await run(12);
  const acts = events.filter(e => e.type === "actions" && e.id === "h").map(e => e.actions);
  assert.ok(acts.length >= 10, "hostile module kept ticking (bad values are not a crime, they are just dropped)");
  for (const a of acts) {
    assert.ok(Number.isFinite(a.throttle) && Number.isFinite(a.steer), "throttle/steer finite");
    assert.equal(a.throttle, 0); assert.equal(a.steer, 0);
    if (a.arm !== null) assert.equal(a.arm, 0);
    if (a.led) for (const v of a.led) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1);
    for (const [, v] of a.logs) assert.ok(Number.isFinite(v));
    for (const [i, v] of a.mem) assert.ok(Number.isInteger(i) && Number.isFinite(v));
  }
  assert.ok(acts.some(a => a.logs.some(([c, v]) => c === 8 && v === 1)), "the finite log still arrives");
  assert.ok(!acts.some(a => a.logs.some(([c]) => c === 7)), "the NaN log is dropped");
  assert.deepEqual(Float32Array.from(reg.get("h").mem), memBefore, "object memory untouched by Infinity/NaN writes");
  // host-side boundary check, independent of the worker: feed raw garbage straight into the sanitiser
  const { actions, bad } = Registry.sanitizeActions({ throttle: NaN, steer: Infinity, arm: -Infinity, led: [NaN, 2, -1], logs: [[1, NaN], [2, 3], "x"], mem: [[0, Infinity], [70, 1], [1, 0.5]], ms: NaN });
  assert.deepEqual(actions, { throttle: 0, steer: 0, arm: 0, led: [0, 1, 0], logs: [[2, 3]], mem: [[1, 0.5]], ms: undefined });
  assert.equal(bad, 8);   // throttle, steer, arm, one LED NaN, one NaN log, one malformed log, one Infinity mem write, one out-of-range slot
  const errs = events.filter(e => e.type === "log" && e.level === "err" && e.id === "h");
  assert.equal(errs.length, 0, "worker-side validation means the registry sees clean actions from this module");
  reg.unload("h");
});

test("version increments on each successful replace, not on a rejected one", async () => {
  const { reg, run } = makeWorld();
  reg.add({ id: "v", version: 1 });
  await reg.load("v", { name: "patrol", bytes: wasm("patrol") });
  assert.equal(reg.get("v").version, 1, "first load is not a replace");
  await reg.load("v", { name: "seek_target", bytes: wasm("seek_target") });
  assert.equal(reg.get("v").version, 2);
  await assert.rejects(reg.load("v", { name: "evil", bytes: EVIL }));
  assert.equal(reg.get("v").version, 2, "a rejected replace does not bump the version");
  await run(3);
  reg.unload("v");
});

test("objects carry owner and version; remove unloads; unknown ids throw", async () => {
  const { reg } = makeWorld();
  const o = reg.add({ id: "o1", owner: "carol", version: 3, manifest: { name: "thing" } });
  assert.equal(o.owner, "carol"); assert.equal(o.version, 3); assert.equal(o.manifest.name, "thing");
  assert.throws(() => reg.add({ id: "o1" }), /already exists/);
  assert.throws(() => reg.load("nope", { name: "patrol", bytes: wasm("patrol") }), /no object "nope"/);
  await reg.load("o1", { name: "patrol", bytes: wasm("patrol") });
  reg.remove("o1");
  assert.equal(reg.has("o1"), false);
  assert.equal(reg.list().length, 0);
});

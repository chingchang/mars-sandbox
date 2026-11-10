// The sandbox worker. Owns exactly one Wasm module instance for one object.
// Runs as a module Web Worker in the browser and as a worker_threads Worker in
// Node (tests); the only difference is the message port. It has no access to
// the page, the scene, the network or the authoritative world state: it sees
// the sensor snapshot the host sends each tick and returns requests.
//
// Protocol (host -> worker):   { type:"load", bytes, sensors, mem, world: { terrain, facts } }
//                              { type:"tick", dt, sensors, entities, selfIndex, signals: { codes, values } }
//          (worker -> host):   { type:"loaded", imports, actions, memBytes }
//                              { type:"actions", actions }   actions: throttle, steer, arm, led, logs, mem,
//                                  spawn, pose, remove, state, signals, ms (tick wall time), memBytes
//                              { type:"error", msg }
const isNode = typeof self === "undefined";
let post, onMessage;
if (isNode) {
  const { parentPort } = await import("node:worker_threads");
  post = (m, transfer) => parentPort.postMessage(m, transfer);
  onMessage = fn => parentPort.on("message", fn);
} else {
  post = (m, transfer) => self.postMessage(m, transfer);
  onMessage = fn => { self.onmessage = e => fn(e.data); };
}

// The import allow-list: the whole host API a module may call (behaviors/host.ts).
// Append only; never renumber sensor keys.
export const ALLOWED = new Set(["read", "drive", "set_arm", "set_led", "log", "mem_get", "mem_set",
  "spawn", "pose", "remove", "state_set", "signal_emit", "signal_read", "terrain_height", "nearest", "nearest_bearing", "fact", "fact_tier"]);
export const SENSOR_COUNT = 14, MEM_SLOTS = 64, MAX_SHAPES = 32, STATE_SLOTS = 16, MAX_SIGNALS_PER_TICK = 32, MAX_MEMORY_PAGES = 256;
import { memoryPolicy } from "./wasm_limits.mjs";

let instance = null, sensors = new Float32Array(SENSOR_COUNT), mem = new Float32Array(MEM_SLOTS);
let act = null;
// world data: terrain grid (at load), fact table (at load), entities + signals (per tick)
let terrain = null, facts = { values: new Float32Array(0), tiers: new Int8Array(0) };
let entities = new Float32Array(0), selfIndex = -1, signalsIn = new Map();
const shapes = new Set(); let freedThisTick = new Set();   // handles: lowest free one is reused, but never one freed in the same tick
// Every numeric argument is validated here: a non-finite number (NaN, +/-Infinity)
// is treated as 0 by the clamped actuators and makes mem_set and log ignore the
// call. Math.max/min pass NaN through, so the check must come first. The registry
// validates again on the host side; this is defence in depth, not the boundary.
const fin = v => (Number.isFinite(v) ? v : 0);
const wrapAngle = a => { a = fin(a); if (Math.abs(a) <= Math.PI) return a; a = a % (2 * Math.PI); return a > Math.PI ? a - 2 * Math.PI : a < -Math.PI ? a + 2 * Math.PI : a; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, fin(v)));
function freshActions() { return { throttle: 0, steer: 0, arm: null, led: null, logs: [], mem: [], spawn: [], pose: [], remove: [], state: [], signals: [] }; }
function terrainHeight(x, z) {
  if (!terrain || !Number.isFinite(x) || !Number.isFinite(z)) return 0;
  const { n, res, cx, cz, data } = terrain;
  const col = cx + x / res, row = cz + z / res;
  if (col < 0 || row < 0 || col > n - 1 || row > n - 1) return 0;
  const c0 = Math.floor(col), r0 = Math.floor(row), fc = col - c0, fr = row - r0;
  const at = (r, c) => data[Math.min(n - 1, r) * n + Math.min(n - 1, c)];
  return (at(r0, c0) * (1 - fr) + at(r0 + 1, c0) * fr) * (1 - fc) + (at(r0, c0 + 1) * (1 - fr) + at(r0 + 1, c0 + 1) * fr) * fc;
}
function nearestOf(kind, x, z) {           // entities: [kind, x, z, objectIndex] * n; skips this object itself
  let best = -1, bx = 0, bz = 0;
  for (let i = 0; i + 3 < entities.length; i += 4) {
    if (entities[i] !== kind || entities[i + 3] === selfIndex) continue;
    const d = Math.hypot(entities[i + 1] - x, entities[i + 2] - z);
    if (best < 0 || d < best) { best = d; bx = entities[i + 1]; bz = entities[i + 2]; }
  }
  return { d: best, bx, bz };
}
const host = {
  read: k => (k >= 0 && k < SENSOR_COUNT) ? sensors[k | 0] : 0,
  drive: (t, s) => { act.throttle = clamp(t, -1, 1); act.steer = clamp(s, -1, 1); },
  set_arm: a => { act.arm = clamp(a, 0, 1); },
  set_led: (r, g, b) => { act.led = [r, g, b].map(v => clamp(v, 0, 1)); },
  log: (c, v) => { if (Number.isFinite(v) && act.logs.length < 8) act.logs.push([c | 0, v]); },
  mem_get: i => (i >= 0 && i < MEM_SLOTS) ? mem[i | 0] : 0,
  mem_set: (i, v) => { if (i >= 0 && i < MEM_SLOTS && Number.isFinite(v)) { mem[i | 0] = v; act.mem.push([i | 0, v]); } },
  // ---- generic object API (X1) ----
  spawn: (shape, w, h, d, r, g, b) => {
    if (shapes.size >= MAX_SHAPES) return -1;
    let handle = 0; while (handle < MAX_SHAPES && (shapes.has(handle) || freedThisTick.has(handle))) handle++;
    if (handle >= MAX_SHAPES) return -1;                       // every free handle was freed this tick: try next tick
    shapes.add(handle);
    const size = v => clamp(fin(v) || 0.1, 0.01, 50);
    act.spawn.push([handle, clamp(shape | 0, 0, 4), size(w), size(h), size(d), clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1)]);
    return handle;
  },
  // offsets clamped to +/-50 m (the size cap) so a module cannot draw on top of a distant object; angles wrapped to +/-pi
  pose: (handle, x, y, z, yaw, pitch) => { if (shapes.has(handle | 0)) act.pose.push([handle | 0, clamp(x, -50, 50), clamp(y, -50, 50), clamp(z, -50, 50), wrapAngle(yaw), wrapAngle(pitch)]); },
  remove: handle => { if (shapes.delete(handle | 0)) { freedThisTick.add(handle | 0); act.remove.push(handle | 0); } },
  state_set: (slot, v) => { if (slot >= 0 && slot < STATE_SLOTS && Number.isFinite(v)) act.state.push([slot | 0, v]); },
  signal_emit: (code, v) => { if (code >= 0 && code <= 65535 && Number.isFinite(v) && act.signals.length < MAX_SIGNALS_PER_TICK) act.signals.push([code | 0, v]); },
  signal_read: code => signalsIn.get(code | 0) ?? 0,
  terrain_height: (x, z) => terrainHeight(x, z),
  nearest: (kind, x, z) => nearestOf(kind | 0, fin(x), fin(z)).d,
  nearest_bearing: (kind, x, z) => { const n = nearestOf(kind | 0, fin(x), fin(z)); return n.d < 0 ? 0 : Math.atan2(n.bx - fin(x), n.bz - fin(z)); },
  fact: key => (key >= 0 && key < facts.values.length) ? facts.values[key | 0] : NaN,
  fact_tier: key => (key >= 0 && key < facts.tiers.length) ? facts.tiers[key | 0] : -1,
};

onMessage(async m => {
  if (m.type === "load") {
    try {
      // memory ceiling: exactly one linear memory (or none), declared maximum, under MAX_MEMORY_PAGES, no memory64
      const why = memoryPolicy(m.bytes, MAX_MEMORY_PAGES);
      if (why) throw new Error(why);
      const mod = await WebAssembly.compile(m.bytes);
      const imports = WebAssembly.Module.imports(mod);
      for (const imp of imports) {
        if (imp.module !== "host" || !ALLOWED.has(imp.name)) throw new Error("illegal import " + imp.module + "." + imp.name);
      }
      const exps = WebAssembly.Module.exports(mod).map(x => x.name);
      if (!exps.includes("tick") || !exps.includes("init")) throw new Error("module must export init() and tick(dt)");
      mem.set(m.mem);
      sensors.set(m.sensors);
      if (m.world) { terrain = m.world.terrain ?? null; if (m.world.facts) facts = m.world.facts; }
      shapes.clear(); freedThisTick = new Set();
      instance = (await WebAssembly.instantiate(mod, { host })).exports;
      act = freshActions();
      instance.init();
      post({ type: "loaded", imports: imports.map(i => i.module + "." + i.name), actions: act, memBytes: instance.memory ? instance.memory.buffer.byteLength : 0 });
    } catch (err) { post({ type: "error", msg: String(err && err.message || err) }); }
  } else if (m.type === "tick" && instance) {
    sensors.set(m.sensors);
    if (m.entities) entities = m.entities;
    if (typeof m.selfIndex === "number") selfIndex = m.selfIndex;
    signalsIn = new Map(); if (m.signals) for (let i = 0; i < m.signals.codes.length; i++) signalsIn.set(m.signals.codes[i], m.signals.values[i]);
    act = freshActions(); freedThisTick = new Set();
    const t0 = performance.now();
    try { instance.tick(m.dt); }
    catch (err) { post({ type: "error", msg: "trap in tick(): " + String(err && err.message || err) }); return; }
    act.ms = performance.now() - t0;
    act.memBytes = instance.memory ? instance.memory.buffer.byteLength : 0;
    post({ type: "actions", actions: act });
  }
});

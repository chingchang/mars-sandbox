// The sandbox worker. Owns exactly one Wasm module instance for one object.
// Runs as a module Web Worker in the browser and as a worker_threads Worker in
// Node (tests); the only difference is the message port. It has no access to
// the page, the scene, the network or the authoritative world state: it sees
// the sensor snapshot the host sends each tick and returns requests.
//
// Protocol (host -> worker):   { type:"load", bytes, sensors, mem }
//                              { type:"tick", dt, sensors }
//          (worker -> host):   { type:"loaded", imports, actions, memBytes }
//                              { type:"actions", actions }   actions.ms = tick() wall time
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
export const ALLOWED = new Set(["read", "drive", "set_arm", "set_led", "log", "mem_get", "mem_set"]);
export const SENSOR_COUNT = 14, MEM_SLOTS = 64;

let instance = null, sensors = new Float32Array(SENSOR_COUNT), mem = new Float32Array(MEM_SLOTS);
let act = null;
// Every numeric argument is validated here: a non-finite number (NaN, +/-Infinity)
// is treated as 0 by the clamped actuators and makes mem_set and log ignore the
// call. Math.max/min pass NaN through, so the check must come first. The registry
// validates again on the host side; this is defence in depth, not the boundary.
const fin = v => (Number.isFinite(v) ? v : 0);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, fin(v)));
function freshActions() { return { throttle: 0, steer: 0, arm: null, led: null, logs: [], mem: [] }; }
const host = {
  read: k => (k >= 0 && k < SENSOR_COUNT) ? sensors[k | 0] : 0,
  drive: (t, s) => { act.throttle = clamp(t, -1, 1); act.steer = clamp(s, -1, 1); },
  set_arm: a => { act.arm = clamp(a, 0, 1); },
  set_led: (r, g, b) => { act.led = [r, g, b].map(v => clamp(v, 0, 1)); },
  log: (c, v) => { if (Number.isFinite(v) && act.logs.length < 8) act.logs.push([c | 0, v]); },
  mem_get: i => (i >= 0 && i < MEM_SLOTS) ? mem[i | 0] : 0,
  mem_set: (i, v) => { if (i >= 0 && i < MEM_SLOTS && Number.isFinite(v)) { mem[i | 0] = v; act.mem.push([i | 0, v]); } },
};

onMessage(async m => {
  if (m.type === "load") {
    try {
      const mod = await WebAssembly.compile(m.bytes);
      const imports = WebAssembly.Module.imports(mod);
      for (const imp of imports) {
        if (imp.module !== "host" || !ALLOWED.has(imp.name)) throw new Error("illegal import " + imp.module + "." + imp.name);
      }
      const exps = WebAssembly.Module.exports(mod).map(x => x.name);
      if (!exps.includes("tick") || !exps.includes("init")) throw new Error("module must export init() and tick(dt)");
      mem.set(m.mem);
      sensors.set(m.sensors);
      instance = (await WebAssembly.instantiate(mod, { host })).exports;
      act = freshActions();
      instance.init();
      post({ type: "loaded", imports: imports.map(i => i.module + "." + i.name), actions: act, memBytes: instance.memory ? instance.memory.buffer.byteLength : 0 });
    } catch (err) { post({ type: "error", msg: String(err && err.message || err) }); }
  } else if (m.type === "tick" && instance) {
    sensors.set(m.sensors);
    act = freshActions();
    const t0 = performance.now();
    try { instance.tick(m.dt); }
    catch (err) { post({ type: "error", msg: "trap in tick(): " + String(err && err.message || err) }); return; }
    act.ms = performance.now() - t0;
    post({ type: "actions", actions: act });
  }
});

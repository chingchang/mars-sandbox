// ---------------------------------------------------------------------------
// runtime/registry.mjs — the multi-module sandbox runtime (task R1).
//
// A Registry holds live objects. Each object has an id, an owner, a version,
// a position, a manifest, 64 floats of host-owned memory that survive module
// reloads, and zero or one module worker. The registry loads, replaces and
// unloads modules per object with the no-gap swap (the new worker is built
// beside the old one and swapped in only after init() succeeds), and ticks
// every enabled module at TICK_HZ with the per-worker CPU budget and watchdog.
// A module that hangs or traps takes down only its own object.
//
// The registry never touches the world: it hands each object's requested
// actions to the host through onEvent({type:"actions"}), and the host decides.
// Worker creation is injected (spawnWorker) so the same code runs in the
// browser (module Web Worker) and in Node tests (worker_threads).
//
// The registry is the host boundary: every action an object requests is
// validated here (finite numbers, clamped ranges, slot indices) before the host
// sees it, whatever the worker did. Known limit: during a replace, the new
// worker gets a copy of object.mem when the load is posted; mem_set calls the
// old module makes in the few milliseconds before the swap land in object.mem
// but not in the new module's copy.
//
// Events (onEvent): {type:"state", id, state, label} | {type:"log", id, level, text}
//                   | {type:"actions", id, object, actions} | {type:"loaded", id, imports}
//                   | {type:"unloaded", id, reason}
// ---------------------------------------------------------------------------
export const BUDGET_MS = 2.0;          // per tick, per worker
export const WATCHDOG_MS = 400;        // tick() must return within this, or the worker is terminated
export const TICK_HZ = 20;
export const LOAD_TIMEOUT_MS = 3000;
export const OVER_BUDGET_STRIKES = 3;  // consecutive over-budget ticks before the module is disabled

/**
 * The runtime's tick rules as a pure function over a list of tick times (ms), for the smoke test
 * and anything else that judges a module offline. Same rules as the world enforces: a single tick
 * over `watchdog` is a violation (the worker is terminated); `strikes` consecutive ticks over
 * `budget` is a violation (the module is disabled); so is a mean over `budget`. One slow tick
 * under the watchdog is not: the operating system pauses a thread now and then, and the world
 * does not disable a module for it.
 * @returns {{ ok: boolean, reason: string | null, worst: number, over: number, mean: number, strikes: number }}
 */
export function tickVerdict(times, budget = BUDGET_MS, strikes = OVER_BUDGET_STRIKES, watchdog = WATCHDOG_MS) {
  let worst = 0, over = 0, run = 0, longest = 0, sum = 0;
  for (const t of times) {
    sum += t; if (t > worst) worst = t;
    if (t > budget) { over++; run++; if (run > longest) longest = run; } else run = 0;
  }
  const mean = times.length ? sum / times.length : 0;
  let reason = null;
  if (worst > watchdog) reason = `a tick took ${worst.toFixed(0)} ms; the world stops a module whose tick does not return within ${watchdog} ms`;
  else if (longest >= strikes) reason = `${strikes} ticks in a row over ${budget} ms (worst ${worst.toFixed(2)} ms)`;
  else if (mean > budget) reason = `mean tick ${mean.toFixed(2)} ms, budget is ${budget} ms`;
  return { ok: reason === null, reason, worst, over, mean, strikes: longest };
}
export const MEM_SLOTS = 64;
export const SENSOR_COUNT = 16;
export const MAX_SHAPES = 32, STATE_SLOTS = 16, MAX_SIGNALS_PER_TICK = 32, MAX_MEMORY_PAGES = 256;
export const KIND = { ROVER: 0, ROCK: 1, CHARGER: 2, OBJECT: 3 };
import { validateManifest } from "./manifest.mjs";
import { sizePolicy, MAX_MODULE_BYTES } from "./wasm_limits.mjs";
export { MAX_MODULE_BYTES };

export class Registry {
  /**
   * @param {object} opts
   * @param {() => {post(msg, transfer?), onMessage(fn), terminate()}} opts.spawnWorker
   * @param {() => number} [opts.now]  monotonic milliseconds (performance.now)
   * @param {(ev: object) => void} [opts.onEvent]
   */
  constructor({ spawnWorker, now = () => performance.now(), onEvent = () => {}, world = {}, facts = null }) {
    if (typeof spawnWorker !== "function") throw new Error("Registry needs spawnWorker()");
    this.spawnWorker = spawnWorker; this.now = now; this.onEvent = onEvent;
    this.objects = new Map();
    // world data handed to modules: terrain grid (sent at load), entities() (asked once per tick), fact table (at load)
    this.world = { terrain: world.terrain ?? null, entities: world.entities ?? (() => new Float32Array(0)) };
    this.facts = facts;
    this.signals = new Map(); this.nextSignals = new Map();   // world-scoped signals: emitted this tick, readable next tick, then gone
    this.nextIndex = 0;
  }

  /** Register an object. Fields exist now so persistence and multiplayer need no rewrite. */
  add({ id, owner = "player", version = 1, kind = "object", position = { x: 0, y: 0, z: 0, yaw: 0 }, manifest = null }) {
    if (!id || typeof id !== "string") throw new Error("object needs a string id");
    if (this.objects.has(id)) throw new Error(`object "${id}" already exists`);
    const object = { id, owner, version, kind, position: { x: 0, y: 0, z: 0, yaw: 0, ...position }, manifest,
                     mem: new Float32Array(MEM_SLOTS), state: new Float32Array(STATE_SLOTS), shapes: new Map(),
                     index: this.nextIndex++, module: null, lastActions: null, created: this.now() };
    this.objects.set(id, object);
    return object;
  }

  get(id) { return this.objects.get(id) ?? null; }
  list() { return [...this.objects.values()]; }
  has(id) { return this.objects.has(id); }

  remove(id) {
    const o = this.#need(id);
    if (o.module) this.unload(id, "object removed");
    this.objects.delete(id);
  }

  /** Is this object's module alive and ticking? */
  enabled(id) { return !!this.objects.get(id)?.module?.enabled; }

  /**
   * Load a module into an object, replacing any running one only after the new
   * one's init() succeeds. Resolves with {imports, actions}; rejects on an
   * illegal import, a missing export, an init() trap, or a load timeout. On
   * rejection the previous module, if any, keeps running untouched.
   */
  load(id, { name, bytes, logNames = {}, sensors = null, manifest = undefined }) {
    const object = this.#need(id);
    if (manifest !== undefined) {
      const errs = validateManifest(manifest);
      if (errs.length) { this.#emit({ type: "log", id, level: "err", text: `rejected "${name}": bad manifest: ${errs.join("; ")}` }); return Promise.reject(new Error("bad manifest: " + errs.join("; "))); }
    }
    // the size ceiling is checked here, before the bytes are copied or a worker exists, and again in the worker's policy
    const tooBig = sizePolicy(bytes instanceof Uint8Array ? bytes.length : bytes.byteLength);
    if (tooBig) { this.#emit({ type: "log", id, level: "err", text: `rejected "${name}": ${tooBig}` }); return Promise.reject(new Error(tooBig)); }
    const bytesCopy = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes);
    const w = this.spawnWorker();
    this.#emit({ type: "state", id, state: "loading", label: "verifying + instantiating" });
    this.#emit({ type: "log", id, level: "host", text: `loading "${name}" (${bytesCopy.byteLength} bytes) in a fresh worker` });
    return new Promise((resolve, reject) => {
      const fail = (msg) => {
        clearTimeout(killer); w.terminate();
        this.#emit({ type: "log", id, level: "err", text: `rejected "${name}": ${msg}` });
        this.#emit({ type: "state", id, state: object.module?.enabled ? "running" : "dead", label: object.module?.enabled ? "running" : "rejected" });
        reject(new Error(msg));
      };
      const killer = setTimeout(() => fail(`load timed out after ${LOAD_TIMEOUT_MS} ms; old module kept`), LOAD_TIMEOUT_MS);
      w.onMessage(m => {
        if (m.type === "loaded") {
          clearTimeout(killer);
          if (object.module?.worker) { object.module.worker.terminate(); this.#emit({ type: "log", id, level: "host", text: `old module "${object.module.name}" terminated` }); }
          const replaced = !!object.module;
          if (replaced) this.#clearShapes(object);               // the old module's shapes go with it
          if (manifest !== undefined) object.manifest = manifest;
          object.module = { name, worker: w, enabled: true, state: "running", inflight: false, lastSent: 0, over: 0, avgMs: 0, ticks: 0, imports: m.imports, logNames, badActions: 0 };
          if (replaced) object.version += 1;                  // "radar v2": the object's version counts successful replacements
          // bind the handler to this worker: a message from a worker that is no longer the object's module is ignored
          w.onMessage(msg => { if (object.module?.worker === w) this.#onWorkerMessage(object, msg); });
          this.#applyActions(object, m.actions);
          this.#emit({ type: "loaded", id, imports: m.imports });
          this.#emit({ type: "state", id, state: "running", label: "running" });
          this.#emit({ type: "log", id, level: "host", text: `imports verified: ${m.imports.join(", ")}` });
          this.#emit({ type: "log", id, level: "host", text: `"${name}" is live on "${id}". The world never paused.` });
          resolve({ imports: m.imports, actions: m.actions });
        } else if (m.type === "error") fail(m.msg);
      });
      const snapshot = sensors ?? new Float32Array(SENSOR_COUNT);
      w.post({ type: "load", bytes: bytesCopy, sensors: snapshot, mem: object.mem, world: { terrain: this.world.terrain, facts: this.facts } }, [bytesCopy.buffer]);
    });
  }

  unload(id, reason = "unloaded") {
    const object = this.#need(id);
    const mod = object.module;
    if (!mod) return false;
    if (mod.worker) mod.worker.terminate();
    object.module = null;
    this.#clearShapes(object);
    this.#emit({ type: "state", id, state: "dead", label: reason });
    this.#emit({ type: "log", id, level: "host", text: `module "${mod.name}" on "${id}" ${reason}` });
    this.#emit({ type: "unloaded", id, reason, name: mod.name });
    return true;
  }

  /**
   * One scheduler step: for every enabled module, enforce the watchdog on an
   * outstanding tick, otherwise send a new tick with this object's sensors.
   * `sensorsFor(object)` returns a Float32Array(SENSOR_COUNT) snapshot.
   */
  tick(now, sensorsFor, dt = 1 / TICK_HZ) {
    let sent = 0;
    this.signals = this.nextSignals; this.nextSignals = new Map();           // signals expire after one tick unless re-emitted
    const codes = Int32Array.from(this.signals.keys()), values = Float32Array.from(this.signals.values());
    const entities = this.world.entities();
    for (const object of this.objects.values()) {
      const mod = object.module;
      if (!mod?.enabled) continue;
      if (mod.inflight) {
        if (now - mod.lastSent > WATCHDOG_MS) {
          this.#emit({ type: "log", id: object.id, level: "err", text: `watchdog: tick() did not return in ${WATCHDOG_MS} ms` });
          this.unload(object.id, "killed by watchdog");
        }
        continue;
      }
      mod.inflight = true; mod.lastSent = now;
      mod.worker.post({ type: "tick", dt, sensors: sensorsFor(object), entities, selfIndex: object.index, signals: { codes, values } });
      sent++;
    }
    return sent;
  }

  stats(id) {
    const o = this.#need(id), m = o.module;
    return m ? { name: m.name, enabled: m.enabled, ticks: m.ticks, avgMs: m.avgMs, over: m.over, imports: m.imports, badActions: m.badActions, shapes: o.shapes.size, memBytes: m.memBytes ?? 0 } : null;
  }

  #onWorkerMessage(object, m) {
    const mod = object.module;
    if (!mod || mod.state !== "running") return;          // a message from a worker we already replaced or killed
    mod.inflight = false;
    if (m.type === "error") { this.#emit({ type: "log", id: object.id, level: "err", text: m.msg }); this.unload(object.id, "trapped"); return; }
    if (m.type !== "actions") return;
    mod.ticks++;
    this.#applyActions(object, m.actions);
    mod.avgMs = mod.avgMs * 0.9 + m.actions.ms * 0.1;
    if (m.actions.ms > BUDGET_MS) {
      if (++mod.over >= OVER_BUDGET_STRIKES) {
        this.#emit({ type: "log", id: object.id, level: "err", text: `tick() over ${BUDGET_MS} ms budget ${OVER_BUDGET_STRIKES}x in a row` });
        this.unload(object.id, "disabled: over budget");
      }
    } else mod.over = 0;
  }

  /** Host-side validation of a worker's actions; returns a sanitised copy and counts what was dropped. */
  static sanitizeActions(a) {
    let bad = 0;
    const num = (v, lo, hi) => { if (!Number.isFinite(v)) { bad++; return 0; } return Math.max(lo, Math.min(hi, v)); };
    const out = { throttle: num(a.throttle, -1, 1), steer: num(a.steer, -1, 1), arm: null, led: null, logs: [], mem: [], spawn: [], pose: [], remove: [], state: [], signals: [],
                  ms: Number.isFinite(a.ms) ? a.ms : undefined, memBytes: Number.isFinite(a.memBytes) ? a.memBytes : undefined };
    if (a.arm !== null && a.arm !== undefined) out.arm = num(a.arm, 0, 1);
    if (Array.isArray(a.led) && a.led.length === 3) out.led = a.led.map(v => num(v, 0, 1));
    for (const e of Array.isArray(a.logs) ? a.logs : []) { if (Array.isArray(e) && Number.isInteger(e[0]) && Number.isFinite(e[1])) out.logs.push([e[0], e[1]]); else bad++; }
    for (const e of Array.isArray(a.mem) ? a.mem : []) { if (Array.isArray(e) && Number.isInteger(e[0]) && e[0] >= 0 && e[0] < MEM_SLOTS && Number.isFinite(e[1])) out.mem.push([e[0], e[1]]); else bad++; }
    const handle = h => Number.isInteger(h) && h >= 0 && h < MAX_SHAPES;
    const allFinite = (arr, n) => Array.isArray(arr) && arr.length === n && arr.every(Number.isFinite);
    for (const e of Array.isArray(a.spawn) ? a.spawn : []) {
      if (allFinite(e, 8) && handle(e[0]) && Number.isInteger(e[1]) && e[1] >= 0 && e[1] <= 4) out.spawn.push([e[0], e[1], ...e.slice(2, 5).map(v => Math.max(0.01, Math.min(50, v))), ...e.slice(5, 8).map(v => Math.max(0, Math.min(1, v)))]); else bad++;
    }
    for (const e of Array.isArray(a.pose) ? a.pose : []) { if (allFinite(e, 6) && handle(e[0])) out.pose.push([...e]); else bad++; }
    for (const h of Array.isArray(a.remove) ? a.remove : []) { if (handle(h)) out.remove.push(h); else bad++; }
    for (const e of Array.isArray(a.state) ? a.state : []) { if (Array.isArray(e) && Number.isInteger(e[0]) && e[0] >= 0 && e[0] < STATE_SLOTS && Number.isFinite(e[1])) out.state.push([e[0], e[1]]); else bad++; }
    for (const e of Array.isArray(a.signals) ? a.signals : []) { if (Array.isArray(e) && Number.isInteger(e[0]) && e[0] >= 0 && e[0] <= 65535 && Number.isFinite(e[1]) && out.signals.length < MAX_SIGNALS_PER_TICK) out.signals.push([e[0], e[1]]); else bad++; }
    return { actions: out, bad };
  }

  #applyActions(object, raw) {
    const { actions: a, bad } = Registry.sanitizeActions(raw);
    if (bad && object.module && object.module.badActions++ === 0) {
      this.#emit({ type: "log", id: object.id, level: "err", text: `"${object.module.name}" on "${object.id}" sent non-finite or malformed values; they were dropped (reported once)` });
    }
    for (const [i, v] of a.mem) object.mem[i] = v;   // host-owned memory, per object
    // shapes: handles are per object; the worker only knows its own, and the registry only honours handles it has seen spawned
    for (const [h, shape, w, hh, d, r, g, b] of a.spawn) {
      if (object.shapes.size >= MAX_SHAPES || object.shapes.has(h)) continue;
      const spec = { handle: h, shape, w, h: hh, d, r, g, b, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 } };
      object.shapes.set(h, spec); this.#emit({ type: "spawn", id: object.id, object, handle: h, spec });
    }
    for (const [h, x, y, z, yaw, pitch] of a.pose) { const spec = object.shapes.get(h); if (!spec) continue; spec.pose = { x, y, z, yaw, pitch }; this.#emit({ type: "pose", id: object.id, object, handle: h, pose: spec.pose }); }
    for (const h of a.remove) { if (object.shapes.delete(h)) this.#emit({ type: "remove", id: object.id, object, handle: h }); }
    for (const [slot, v] of a.state) { object.state[slot] = v; this.#emit({ type: "slots", id: object.id, object, slot, value: v }); }
    for (const [code, v] of a.signals) { this.nextSignals.set(code, v); this.#emit({ type: "signal", id: object.id, object, code, value: v }); }
    if (object.module && a.memBytes !== undefined) {
      object.module.memBytes = a.memBytes;
      if (a.memBytes > MAX_MEMORY_PAGES * 65536) { this.#emit({ type: "log", id: object.id, level: "err", text: `memory ${a.memBytes} bytes over the ${MAX_MEMORY_PAGES}-page ceiling` }); this.unload(object.id, "disabled: memory over ceiling"); return; }
    }
    object.lastActions = a;
    for (const [c, v] of a.logs) this.#emit({ type: "log", id: object.id, level: "mod", text: `${object.module?.name ?? "?"}: ${object.module?.logNames?.[c] ?? ("code " + c)} ${Number.isFinite(v) ? v.toFixed(2) : v}` });
    this.#emit({ type: "actions", id: object.id, object, actions: a });
  }

  #clearShapes(object) {
    for (const h of [...object.shapes.keys()]) { object.shapes.delete(h); this.#emit({ type: "remove", id: object.id, object, handle: h }); }
  }

  #need(id) { const o = this.objects.get(id); if (!o) throw new Error(`no object "${id}"`); return o; }
  #emit(ev) { try { this.onEvent(ev); } catch (e) { /* host handler errors must not break the scheduler */ } }
}

/** Browser: module Web Worker from a URL. */
export function browserSpawner(workerUrl) {
  return () => {
    const w = new Worker(workerUrl, { type: "module" });
    return { post: (m, t) => w.postMessage(m, t), onMessage: fn => { w.onmessage = e => fn(e.data); }, terminate: () => w.terminate() };
  };
}

/** Node: worker_threads Worker (tests). */
export async function nodeSpawner(workerPath) {
  const { Worker } = await import("node:worker_threads");
  return () => {
    const w = new Worker(workerPath);
    let handler = null;
    w.on("message", m => handler && handler(m));
    w.on("error", e => handler && handler({ type: "error", msg: String(e && e.message || e) }));
    return { post: (m, t) => w.postMessage(m, t), onMessage: fn => { handler = fn; }, terminate: () => w.terminate() };
  };
}

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
// Events (onEvent): {type:"state", id, state, label} | {type:"log", id, level, text}
//                   | {type:"actions", id, object, actions} | {type:"loaded", id, imports}
//                   | {type:"unloaded", id, reason}
// ---------------------------------------------------------------------------
export const BUDGET_MS = 2.0;          // per tick, per worker
export const WATCHDOG_MS = 400;        // tick() must return within this, or the worker is terminated
export const TICK_HZ = 20;
export const LOAD_TIMEOUT_MS = 3000;
export const OVER_BUDGET_STRIKES = 3;  // consecutive over-budget ticks before the module is disabled
export const MEM_SLOTS = 64;
export const SENSOR_COUNT = 14;

export class Registry {
  /**
   * @param {object} opts
   * @param {() => {post(msg, transfer?), onMessage(fn), terminate()}} opts.spawnWorker
   * @param {() => number} [opts.now]  monotonic milliseconds (performance.now)
   * @param {(ev: object) => void} [opts.onEvent]
   */
  constructor({ spawnWorker, now = () => performance.now(), onEvent = () => {} }) {
    if (typeof spawnWorker !== "function") throw new Error("Registry needs spawnWorker()");
    this.spawnWorker = spawnWorker; this.now = now; this.onEvent = onEvent;
    this.objects = new Map();
  }

  /** Register an object. Fields exist now so persistence and multiplayer need no rewrite. */
  add({ id, owner = "player", version = 1, kind = "object", position = { x: 0, y: 0, z: 0, yaw: 0 }, manifest = null }) {
    if (!id || typeof id !== "string") throw new Error("object needs a string id");
    if (this.objects.has(id)) throw new Error(`object "${id}" already exists`);
    const object = { id, owner, version, kind, position: { x: 0, y: 0, z: 0, yaw: 0, ...position }, manifest,
                     mem: new Float32Array(MEM_SLOTS), module: null, lastActions: null, created: this.now() };
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
  load(id, { name, bytes, logNames = {}, sensors = null }) {
    const object = this.#need(id);
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
          object.module = { name, worker: w, enabled: true, state: "running", inflight: false, lastSent: 0, over: 0, avgMs: 0, ticks: 0, imports: m.imports, logNames };
          object.version += object.module ? 0 : 0;
          w.onMessage(msg => this.#onWorkerMessage(object, msg));
          this.#applyActions(object, m.actions);
          this.#emit({ type: "loaded", id, imports: m.imports });
          this.#emit({ type: "state", id, state: "running", label: "running" });
          this.#emit({ type: "log", id, level: "host", text: `imports verified: ${m.imports.join(", ")}` });
          this.#emit({ type: "log", id, level: "host", text: `"${name}" is live on "${id}". The world never paused.` });
          resolve({ imports: m.imports, actions: m.actions });
        } else if (m.type === "error") fail(m.msg);
      });
      const snapshot = sensors ?? new Float32Array(SENSOR_COUNT);
      w.post({ type: "load", bytes: bytesCopy, sensors: snapshot, mem: object.mem }, [bytesCopy.buffer]);
    });
  }

  unload(id, reason = "unloaded") {
    const object = this.#need(id);
    const mod = object.module;
    if (!mod) return false;
    if (mod.worker) mod.worker.terminate();
    object.module = null;
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
      mod.worker.post({ type: "tick", dt, sensors: sensorsFor(object) });
      sent++;
    }
    return sent;
  }

  stats(id) {
    const o = this.#need(id), m = o.module;
    return m ? { name: m.name, enabled: m.enabled, ticks: m.ticks, avgMs: m.avgMs, over: m.over, imports: m.imports } : null;
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

  #applyActions(object, a) {
    for (const [i, v] of a.mem) if (i >= 0 && i < MEM_SLOTS) object.mem[i] = v;   // host-owned memory, per object
    object.lastActions = a;
    for (const [c, v] of a.logs) this.#emit({ type: "log", id: object.id, level: "mod", text: `${object.module?.name ?? "?"}: ${object.module?.logNames?.[c] ?? ("code " + c)} ${Number.isFinite(v) ? v.toFixed(2) : v}` });
    this.#emit({ type: "actions", id: object.id, object, actions: a });
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

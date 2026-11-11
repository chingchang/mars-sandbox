// A small Node world for judging a module's behaviour offline: the real Registry and worker,
// rocks and a rover as entities, the page's kinematics for anything that drives, the real
// fact table (with optional overrides), the shared clock's air temperature for the hour.
// Used by the acceptance behaviour checks and their tests; no prompt text anywhere.
import { Registry, nodeSpawner, SENSOR_COUNT, KIND } from "../../runtime/registry.mjs";
import { buildFactTable } from "../../runtime/facts.mjs";
import { airTempFromRecord } from "../../runtime/clock.mjs";
import { readFileSync } from "node:fs";

const INDEX = JSON.parse(readFileSync(new URL("../../facts/index.json", import.meta.url), "utf8"));
const KEYS = JSON.parse(readFileSync(new URL("../../runtime/fact_keys.json", import.meta.url), "utf8"));
const AIR = INDEX.facts["jezero.temperature.my36_air_hourly_mean"].value;
/** The index's facts, for checks that pick fact ids to vary. */
export function indexInfo() { return { facts: INDEX.facts }; }
const MAX_SPEED = 2.6, TURN = 1.25;                      // web/app.html stepObject()
let spawnerPromise = null;
const spawner = () => (spawnerPromise ??= nodeSpawner(new URL("../../runtime/worker.mjs", import.meta.url)));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** @param {{ rocks?: {x,z,r}[], rover?: {x,z}, hour?: number, factOverrides?: Record<string, number> }} opts */
export async function makeWorld({ rocks = [], rover = { x: 0, z: 0 }, hour = 10, factOverrides = {} } = {}) {
  const index = Object.keys(factOverrides).length ? { ...INDEX, facts: Object.fromEntries(Object.entries(INDEX.facts).map(([id, f]) => [id, id in factOverrides ? { ...f, value: factOverrides[id] } : f])) } : INDEX;
  const facts = buildFactTable(index, KEYS);
  const n = 11, res = 16, c = 5, data = new Float32Array(n * n);   // flat terrain
  const events = [];
  const w = { hour, t: 0, rocks: rocks.map(r => ({ r: 1.2, ...r })), charger: { x: 0, z: -12 }, events, registry: null, hourPerTick: 0 };
  const reg = new Registry({ spawnWorker: await spawner(), onEvent: ev => events.push(ev), facts,
    world: { terrain: { n, res, cx: c, cz: c, data }, entities: () => Float32Array.from([
      ...reg.list().flatMap(o => [o.kind === "rover" ? KIND.ROVER : KIND.OBJECT, o.position.x, o.position.z, o.index]),
      ...w.rocks.flatMap(r => [KIND.ROCK, r.x, r.z, -1]), KIND.CHARGER, w.charger.x, w.charger.z, -1]) } });
  w.registry = reg;
  const roverObj = reg.add({ id: "rover", kind: "rover", owner: "player", position: { x: rover.x, y: 0, z: rover.z, yaw: 0 } });
  w.rover = roverObj;
  w.tempK = () => airTempFromRecord(AIR, w.hour);
  w.sensorsFor = o => {
    const p = o.position, dx = w.charger.x - p.x, dz = w.charger.z - p.z;
    let b = Math.atan2(dx, dz) - p.yaw; while (b > Math.PI) b -= 2 * Math.PI; while (b < -Math.PI) b += 2 * Math.PI;
    let od = 99, os = 0;
    for (const r of w.rocks) { const rx = r.x - p.x, rz = r.z - p.z, d = Math.hypot(rx, rz) - r.r; if (d > 9) continue; let rb = Math.atan2(rx, rz) - p.yaw; while (rb > Math.PI) rb -= 2 * Math.PI; while (rb < -Math.PI) rb += 2 * Math.PI; if (Math.abs(rb) < 0.6 && d < od) { od = Math.max(0, d); os = rb >= 0 ? 1 : -1; } }
    const s = new Float32Array(SENSOR_COUNT);
    s.set([p.x, p.z, p.yaw, p.speed ?? 0, 1, w.hour > 6 && w.hour < 18 ? 100 : 0, w.t, Math.hypot(dx, dz), b, 0, od, os, 99, 0, w.tempK(), w.hour]);
    return s;
  };
  const kinematics = (o, dt) => {
    const p = o.position; if (!reg.enabled(o.id)) { p.throttle = (p.throttle ?? 0) * 0.9; p.steer = 0; }
    p.speed = (p.speed ?? 0) + ((p.throttle ?? 0) * MAX_SPEED - (p.speed ?? 0)) * Math.min(1, dt * 3);
    p.yaw += (p.steer ?? 0) * TURN * dt;
    p.x += Math.sin(p.yaw) * p.speed * dt; p.z += Math.cos(p.yaw) * p.speed * dt;
  };
  w.applyActions = () => { for (const ev of events.splice(0)) { w.log.push(ev); if (ev.type === "actions" && ev.object) { ev.object.position.throttle = ev.actions.throttle; ev.object.position.steer = ev.actions.steer; } } };
  w.log = [];
  /**
   * Tick n times: kinematics from the last actions, then the registry; world time advances dt and the
   * hour by hourPerTick. After each tick the world waits (up to `wait` ms) for every live module's
   * actions, so two runs of the same module follow the same path and a tick is never skipped.
   */
  w.run = async (n, dt = 0.05, wait = 300) => {
    for (let i = 0; i < n; i++) {
      w.applyActions();
      for (const o of reg.list()) if (o.id !== "rover") kinematics(o, dt);
      const live = reg.list().filter(o => reg.enabled(o.id)).map(o => o.id);
      reg.tick(performance.now(), w.sensorsFor);
      w.t += dt; w.hour = (w.hour + w.hourPerTick) % 24;
      const t0 = Date.now();
      while (live.some(id => reg.enabled(id) && !events.some(e => e.type === "actions" && e.id === id)) && Date.now() - t0 < wait) await sleep(1);
    }
    w.applyActions();
  };
  w.add = (id, x, z) => reg.add({ id, owner: "player", position: { x, y: 0, z, yaw: 0, speed: 0 } });
  w.load = (id, name, bytes, manifest) => reg.load(id, { name, bytes, manifest: manifest ?? undefined, logNames: {}, sensors: w.sensorsFor(reg.get(id)) });
  w.shapes = id => [...reg.get(id).shapes.entries()].map(([h, s]) => ({ handle: h, ...s }));
  w.state = id => Array.from(reg.get(id).state);
  w.eventsOf = (id, type) => w.log.filter(e => e.id === id && e.type === type);
  w.close = () => { for (const o of reg.list()) if (o.module) reg.unload(o.id, "done"); };
  return w;
}

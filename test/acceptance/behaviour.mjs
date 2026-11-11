// Behaviour checks for the five acceptance objects, judged in the Node world: what the prompt
// asked for, observed through shapes, state slots, logs and motion. Each returns
// { pass, evidence: string[] }. These judge recorded modules; nothing here feeds the agent.
import { makeWorld } from "./world.mjs";

const COLD_K = 203.15;                                                   // -70 C, the player's threshold in prompt 1
const sig = shapes => shapes.map(s => `${s.shape}:${s.w.toFixed(2)}x${s.h.toFixed(2)}x${s.d.toFixed(2)}:${s.r.toFixed(2)},${s.g.toFixed(2)},${s.b.toFixed(2)}`).sort().join("|");
const red = s => s.r >= 0.6 && s.g <= 0.4 && s.b <= 0.4;
const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const label = (manifest, slot) => manifest?.state?.find(s => s.slot === slot)?.label ?? `slot ${slot}`;
const unitOf = (manifest, slot) => manifest?.state?.find(s => s.slot === slot)?.unit ?? "";

/** 1. Logs the temperature about once per hour (not every tick); a red flag appears or rises below -70 C and not above. */
export async function weatherStation(bytes, manifest) {
  const w = await makeWorld({ hour: 9 }); const ev = [];
  try {
    w.add("obj", 10, 0); await w.load("obj", "candidate", bytes, manifest);
    const logTicks = () => w.eventsOf("obj", "actions").filter(e => e.actions.logs.length > 0).length;
    w.hourPerTick = 1; await w.run(25, 0.05, 25);                      // 24 hour changes, one per tick
    const hourly = logTicks();
    ev.push(`${hourly} ticks with a log over 24 hour changes at one tick per hour`);
    w.log.length = 0;
    w.hourPerTick = 0.25; await w.run(24, 0.05, 25);                   // 6 hour changes at four ticks per hour
    const fine = logTicks();
    ev.push(`${fine} ticks with a log over 6 hour changes at four ticks per hour (every-tick logging would give about 24)`);
    w.hourPerTick = 0;
    const sample = async h => { w.hour = h; await w.run(4, 0.05, 25); const shapes = w.shapes("obj"); return { tempK: w.tempK(), shapes, redY: Math.max(-1, ...shapes.filter(red).map(s => s.pose?.y ?? 0)), st: w.state("obj") }; };
    const cold = await sample(5), warm = await sample(14);
    ev.push(`at 5 h (${cold.tempK.toFixed(1)} K): red shape ${cold.redY >= 0 ? `at y ${cold.redY.toFixed(2)}` : "none"}; at 14 h (${warm.tempK.toFixed(1)} K): red shape ${warm.redY >= 0 ? `at y ${warm.redY.toFixed(2)}` : "none"}`);
    const flag = (cold.redY >= 0 && warm.redY < 0) || (cold.redY >= 0 && warm.redY >= 0 && cold.redY > warm.redY + 0.2);
    const stateFlag = cold.st.some((v, i) => v === 1 && warm.st[i] === 0);
    if (stateFlag) ev.push(`"${label(manifest, cold.st.findIndex((v, i) => v === 1 && warm.st[i] === 0))}" is 1 when cold and 0 when warm`);
    const cadence = hourly >= 20 && fine >= 4 && fine <= 12;
    if (!cadence) ev.push("not one log per hour change");
    return { pass: cadence && (flag || stateFlag), evidence: ev };
  } finally { w.close(); }
}

/** 2. Lit at 19 m and 15 m, unlit at 21 m and 30 m: the 20 m line itself. A lit state may animate; it only has to differ from unlit. */
export async function beacon(bytes, manifest) {
  const w = await makeWorld({ rover: { x: 30, z: 0 } }); const ev = [];
  try {
    w.add("obj", 0, 0); await w.load("obj", "candidate", bytes, manifest);
    const at = async d => { w.rover.position.x = d; await w.run(4, 0.05, 25); return { d, s: sig(w.shapes("obj")), st: w.state("obj") }; };
    const far = await at(30), lit19 = await at(19), edge21 = await at(21), lit15 = await at(15), far2 = await at(30);
    const unlit = far.s;
    const visual = lit19.s !== unlit && lit15.s !== unlit && edge21.s === unlit && far2.s === unlit;
    const litSlot = far.st.findIndex((v, i) => v === 0 && lit19.st[i] === 1 && edge21.st[i] === 0 && lit15.st[i] === 1 && far2.st[i] === 0);
    ev.push(`shapes unlit (30 m): ${unlit || "(none)"}; 19 m differs: ${lit19.s !== unlit}; 21 m same as unlit: ${edge21.s === unlit}; 15 m differs: ${lit15.s !== unlit}; back at 30 m same as unlit: ${far2.s === unlit}`);
    if (litSlot >= 0) ev.push(`"${label(manifest, litSlot)}" is 1 at 19 and 15 m, 0 at 21 and 30 m`);
    return { pass: visual || litSlot >= 0, evidence: ev };
  } finally { w.close(); }
}

/** 3. A shape's yaw moves one way through the day (sampled clear of the horizon); a reported output (a W slot if labelled) is higher at noon than at midnight. */
export async function solarPanel(bytes, manifest) {
  const w = await makeWorld({ hour: 7.5 }); const ev = [];
  try {
    w.add("obj", 0, 0); await w.load("obj", "candidate", bytes, manifest);
    const HOURS = [7.5, 9.5, 12, 14.5, 16.5];
    const at = async h => { w.hour = h; await w.run(4, 0.05, 25); return { yaws: Object.fromEntries(w.shapes("obj").map(s => [s.handle, s.pose?.yaw ?? 0])), st: w.state("obj") }; };
    const samples = {}; for (const h of [...HOURS, 0]) samples[h] = await at(h);
    let best = null;
    for (const hnd of Object.keys(samples[7.5].yaws)) {
      const ys = HOURS.map(h => samples[h].yaws[hnd]);
      const steps = ys.slice(1).map((y, i) => wrap(y - ys[i]));
      const span = Math.abs(wrap(ys[4] - ys[0]));
      const mono = steps.every(s => s > 0.02) || steps.every(s => s < -0.02);
      if (mono && (!best || span > best.span)) best = { hnd, ys, span };
    }
    ev.push(best ? `shape ${best.hnd} yaw at ${HOURS.join("/")} h: ${best.ys.map(y => y.toFixed(2)).join(", ")} rad, one direction, span ${best.span.toFixed(2)} rad` : `no shape's yaw moved one way with the hour (shapes: ${Object.keys(samples[7.5].yaws).join(",") || "none"})`);
    const noon = samples[12].st, night = samples[0].st;
    const higher = i => noon[i] > night[i] + 1e-3 && noon[i] > 0;
    const wSlots = (manifest?.state ?? []).filter(s => /^W\b/i.test(s.unit ?? "")).map(s => s.slot);
    const out = wSlots.find(higher) ?? noon.findIndex((v, i) => higher(i));
    ev.push(out >= 0 ? `"${label(manifest, out)}"${unitOf(manifest, out) ? ` (${unitOf(manifest, out)})` : ""}: ${noon[out].toFixed(2)} at noon, ${night[out].toFixed(2)} at midnight` : "no state slot is higher at noon than at midnight");
    return { pass: !!best && out >= 0, evidence: ev };
  } finally { w.close(); }
}

/** A rock occludes the line from c to r when its centre is within its radius (+0.3 m) of the segment and lies between them. */
export function occluded(c, r, rocks) {
  const dx = r.x - c.x, dz = r.z - c.z, len2 = dx * dx + dz * dz;
  for (const k of rocks) {
    const t = len2 > 0 ? ((k.x - c.x) * dx + (k.z - c.z) * dz) / len2 : 0;
    if (t <= 0 || t >= 1) continue;
    const px = c.x + t * dx, pz = c.z + t * dz, dist = Math.hypot(k.x - px, k.z - pz);
    if (dist <= (k.r ?? 1.2) + 0.3) return { rock: k, dist, t };
  }
  return null;
}

/** 4. Wanders when the rover is far; once the rover is close, a rock occludes the line between them. A control run with the rover kept far must not end up occluded by luck. */
export async function creature(bytes, manifest) {
  const rocks = [{ x: 8, z: 6 }, { x: -7, z: 9 }, { x: 12, z: -5 }, { x: -9, z: -8 }];
  const ev = [];
  const episode = async approach => {
    const w = await makeWorld({ rocks, rover: { x: 60, z: 0 } });
    try {
      const o = w.add("obj", 0, 0); await w.load("obj", "candidate", bytes, manifest);
      await w.run(60, 0.05, 20);
      const moved = Math.hypot(o.position.x, o.position.z);
      if (approach) { w.rover.position.x = o.position.x + 7; w.rover.position.z = o.position.z; }
      await w.run(60, 0.05, 20);                                        // 3 s to react
      const samples = [];                                               // then 5 s of samples: a hider stays hidden, a wanderer passes through
      for (let i = 0; i < 10; i++) { await w.run(10, 0.05, 20); const c = { x: o.position.x, z: o.position.z }, r = { x: w.rover.position.x, z: w.rover.position.z }; samples.push({ c, r, hide: occluded(c, r, w.rocks) }); }
      const last = samples.at(-1), hiddenFor = samples.filter(s => s.hide).length;
      return { moved, c: last.c, r: last.r, hide: hiddenFor >= 8 ? samples.findLast(s => s.hide).hide : null, hiddenFor, dr: Math.hypot(last.r.x - last.c.x, last.r.z - last.c.z) };
    } finally { w.close(); }
  };
  const near = await episode(true), control = await episode(false);
  ev.push(`moved ${near.moved.toFixed(1)} m in 3 s with the rover 60 m away`);
  ev.push(near.hide ? `rover came to 7 m; occluded in ${near.hiddenFor} of 10 samples over the next 5 s; at the end the rock at (${near.hide.rock.x}, ${near.hide.rock.z}) sits ${near.hide.dist.toFixed(2)} m off the creature-rover line, ${(near.hide.t * 100).toFixed(0)}% of the way (rover ${near.dr.toFixed(1)} m away): occluded`
    : `rover came to 7 m; occluded in only ${near.hiddenFor} of 10 samples over the next 5 s; at the end the creature (${near.c.x.toFixed(1)}, ${near.c.z.toFixed(1)}) has no rock between it and the rover (${near.dr.toFixed(1)} m away)`);
  ev.push(control.hiddenFor >= 8 ? `control (rover kept at 60 m): occluded in ${control.hiddenFor} of 10 samples there too, so hiding could be luck` : `control (rover kept at 60 m): occluded in ${control.hiddenFor} of 10 samples; no rock between them`);
  return { pass: near.moved >= 1 && !!near.hide && control.hiddenFor < 8, evidence: ev };
}

/** 5. A dirt estimate (a slot that is not the tau value itself) grows by a clear ratio when every optical-depth fact the module could have used is raised. */
export async function dustGauge(bytes, manifest) {
  const { facts } = await import("./world.mjs").then(m => m.indexInfo());
  const candidates = (manifest?.fact_ids?.length ? manifest.fact_ids : Object.keys(facts)).filter(id => facts[id] && typeof facts[id].value === "number" && !facts[id].superseded_by && /optical_depth|tau/.test(id));
  const ev = [];
  if (!candidates.length) { ev.push("the manifest cites no scalar optical-depth fact and none is in the index"); return { pass: false, evidence: ev }; }
  const run = async overrides => { const w = await makeWorld({ factOverrides: overrides }); try { w.add("obj", 0, 0); await w.load("obj", "candidate", bytes, manifest); await w.run(200, 0.05, 15); return w.state("obj"); } finally { w.close(); } };
  const base = await run({}), high = await run(Object.fromEntries(candidates.map(id => [id, facts[id].value * 4])));
  const tauValues = new Set(candidates.flatMap(id => [facts[id].value, facts[id].value * 4]));
  const isTauCopy = i => tauValues.has(base[i]) || tauValues.has(high[i]) || (base[i] !== 0 && Math.abs(high[i] / base[i] - 4) < 1e-3 && candidates.some(id => Math.abs(base[i] - facts[id].value) < 1e-6));
  const slot = base.findIndex((v, i) => Number.isFinite(v) && v > 0 && Number.isFinite(high[i]) && high[i] / v >= 1.5 && !isTauCopy(i));
  ev.push(`raised ${candidates.join(", ")} fourfold over 10 s of world time`);
  ev.push(slot >= 0 ? `"${label(manifest, slot)}": ${base[slot].toExponential(3)} with the index values, ${high[slot].toExponential(3)} raised (ratio ${(high[slot] / base[slot]).toFixed(2)})`
    : `no slot other than a copy of the tau value grew by 1.5x or more (base ${base.map((v, i) => `${i}:${v.toExponential(2)}`).filter((_, i) => base[i] !== 0 || high[i] !== 0).join(" ") || "all zero"})`);
  return { pass: slot >= 0, evidence: ev };
}

export const CHECKS = { 1: weatherStation, 2: beacon, 3: solarPanel, 4: creature, 5: dustGauge };

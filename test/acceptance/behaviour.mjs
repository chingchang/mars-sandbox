// Behaviour checks for the five acceptance objects, judged in the Node world: what the prompt
// asked for, observed through shapes, state slots, logs and motion. Each returns
// { pass, evidence: string[] }. These judge recorded modules; nothing here feeds the agent.
import { makeWorld, indexInfo } from "./world.mjs";

const COLD_K = 203.15;                                                   // -70 C, the player's threshold in prompt 1
const sig = shapes => shapes.map(s => `${s.shape}:${s.w.toFixed(2)}x${s.h.toFixed(2)}x${s.d.toFixed(2)}:${s.r.toFixed(2)},${s.g.toFixed(2)},${s.b.toFixed(2)}`).sort().join("|");
const red = s => s.r >= 0.6 && s.g <= 0.4 && s.b <= 0.4;
const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const label = (manifest, slot) => manifest?.state?.find(s => s.slot === slot)?.label ?? `slot ${slot}`;
const unitOf = (manifest, slot) => manifest?.state?.find(s => s.slot === slot)?.unit ?? "";
const brightest = shapes => shapes.reduce((m, s) => Math.max(m, s.r, s.g, s.b), 0);

/**
 * 1. Logs the temperature about once per hour (not every tick); a red flag appears or rises below -70 C
 * and not above, tested far from the threshold (5 h, 14 h) and either side of it on the measured curve
 * (1.5 h at 200.9 K, 7.5 h at 206.7 K).
 */
export async function weatherStation(bytes, manifest) {
  const w = await makeWorld({ hour: 9 }); const ev = [];
  try {
    w.add("obj", 10, 0); await w.load("obj", "candidate", bytes, manifest);
    const logTicks = () => w.eventsOf("obj", "actions").filter(e => e.actions.logs.length > 0).length;
    w.hourPerTick = 1; await w.run(25);                                // 24 hour changes, one per tick
    const hourly = logTicks();
    ev.push(`${hourly} ticks with a log over 24 hour changes at one tick per hour`);
    w.log.length = 0;
    w.hourPerTick = 0.25; await w.run(24);                             // 6 hour changes at four ticks per hour
    const fine = logTicks();
    ev.push(`${fine} ticks with a log over 6 hour changes at four ticks per hour (every-tick logging would give about 24)`);
    w.hourPerTick = 0;
    const sample = async h => { w.hour = h; await w.run(4); const shapes = w.shapes("obj"); return { h, tempK: w.tempK(), redY: Math.max(-1, ...shapes.filter(red).map(s => s.pose?.y ?? 0)), st: w.state("obj") }; };
    const cold = await sample(5), warm = await sample(14), justCold = await sample(1.5), justWarm = await sample(7.5);
    const desc = s => `${s.h} h (${s.tempK.toFixed(1)} K): red shape ${s.redY >= 0 ? `at y ${s.redY.toFixed(2)}` : "none"}`;
    ev.push([cold, warm, justCold, justWarm].map(desc).join("; "));
    const raised = (a, b) => (a.redY >= 0 && b.redY < 0) || (a.redY >= 0 && b.redY >= 0 && a.redY > b.redY + 0.2);     // a shows the flag, b does not
    const shapeFlag = raised(cold, warm) && raised(justCold, justWarm) && raised(justCold, warm) && raised(cold, justWarm);
    const slotFlag = cold.st.findIndex((v, i) => v === 1 && justCold.st[i] === 1 && warm.st[i] === 0 && justWarm.st[i] === 0);
    if (slotFlag >= 0) ev.push(`"${label(manifest, slotFlag)}" is 1 at 5 h and 1.5 h, 0 at 14 h and 7.5 h`);
    const cadence = hourly >= 20 && fine >= 4 && fine <= 12;
    if (!cadence) ev.push("not one log per hour change");
    if (!shapeFlag && slotFlag < 0) ev.push(`no flag that is up below ${COLD_K} K (5 h, 1.5 h) and down above it (7.5 h, 14 h)`);
    return { pass: cadence && (shapeFlag || slotFlag >= 0), evidence: ev };
  } finally { w.close(); }
}

/** 2. Lit at 19 m and 15 m, unlit at 21 m and 30 m: the 20 m line itself, with a direction: lit is brighter, has an added shape, or a slot at 1. */
export async function beacon(bytes, manifest) {
  const w = await makeWorld({ rover: { x: 30, z: 0 } }); const ev = [];
  try {
    w.add("obj", 0, 0); await w.load("obj", "candidate", bytes, manifest);
    const at = async d => { w.rover.position.x = d; await w.run(4); const shapes = w.shapes("obj"); return { d, s: sig(shapes), bright: brightest(shapes), n: shapes.length, st: w.state("obj") }; };
    const far = await at(30), lit19 = await at(19), edge21 = await at(21), lit15 = await at(15), far2 = await at(30);
    const inside = [lit19, lit15], outside = [far, edge21, far2];
    const differs = inside.every(i => i.s !== far.s) && outside.every(o => o.s === far.s);
    const brighter = Math.min(...inside.map(i => i.bright)) > Math.max(...outside.map(o => o.bright)) + 0.05;
    const added = Math.min(...inside.map(i => i.n)) > Math.max(...outside.map(o => o.n));
    const litSlot = far.st.findIndex((v, i) => v === 0 && lit19.st[i] === 1 && edge21.st[i] === 0 && lit15.st[i] === 1 && far2.st[i] === 0);
    ev.push(`shapes unlit (30 m): ${far.s || "(none)"}; 19 m differs: ${lit19.s !== far.s}; 21 m same as unlit: ${edge21.s === far.s}; 15 m differs: ${lit15.s !== far.s}; back at 30 m same as unlit: ${far2.s === far.s}`);
    ev.push(`brightest colour channel inside: ${Math.min(...inside.map(i => i.bright)).toFixed(2)}, outside: ${Math.max(...outside.map(o => o.bright)).toFixed(2)}; shapes inside: ${Math.min(...inside.map(i => i.n))}, outside: ${Math.max(...outside.map(o => o.n))}`);
    if (litSlot >= 0) ev.push(`"${label(manifest, litSlot)}" is 1 at 19 and 15 m, 0 at 21 and 30 m`);
    if (differs && !brighter && !added && litSlot < 0) ev.push("the change inside 20 m is not a lighting-up: not brighter, no added shape, no slot at 1 inside");
    return { pass: (differs && (brighter || added)) || litSlot >= 0, evidence: ev };
  } finally { w.close(); }
}

/**
 * 3. A shape's yaw follows the sun: the hours are visited out of order and held until the yaw is steady,
 * then sorted; the steady yaws must move one way. A reported output (a W slot if labelled; never the
 * hour or the temperature) is higher at noon than at midnight.
 */
export async function solarPanel(bytes, manifest) {
  const w = await makeWorld({ hour: 12 }); const ev = [];
  try {
    w.add("obj", 0, 0); await w.load("obj", "candidate", bytes, manifest);
    const yawsNow = () => Object.fromEntries(w.shapes("obj").map(s => [s.handle, s.pose?.yaw ?? 0]));
    const pitchesNow = () => Object.fromEntries(w.shapes("obj").map(s => [s.handle, s.pose?.pitch ?? 0]));
    /** Hold the hour until no shape's yaw moved more than 0.01 rad over 10 ticks (up to 60 s of world time, so a slow motor settles and a spinner never does). */
    const settle = async h => {
      w.hour = h; let history = [];
      for (let i = 0; i < 1200; i++) {
        await w.run(1); history.push(yawsNow()); if (history.length > 10) history.shift();
        if (history.length === 10 && Object.keys(history[9]).every(k => history.every(y => Math.abs(wrap((y[k] ?? 0) - history[9][k])) < 0.01))) return { yaws: history[9], pitches: pitchesNow(), st: w.state("obj"), steady: true, ticks: i + 1, tempK: w.tempK() };
      }
      return { yaws: yawsNow(), pitches: pitchesNow(), st: w.state("obj"), steady: false, ticks: 1200, tempK: w.tempK() };
    };
    const ORDER = [12, 7.5, 16.5, 9.5, 14.5];
    const samples = {}; for (const h of ORDER) samples[h] = await settle(h);
    const unsteady = ORDER.filter(h => !samples[h].steady);
    const HOURS = [...ORDER].sort((a, b) => a - b);
    let best = null;
    for (const hnd of Object.keys(samples[12].yaws)) {
      const ys = HOURS.map(h => samples[h].yaws[hnd] ?? 0);
      const steps = ys.slice(1).map((y, i) => wrap(y - ys[i]));
      const span = Math.abs(wrap(ys[4] - ys[0]));
      const mono = steps.every(s => s > 0.02) || steps.every(s => s < -0.02);
      if (mono && (!best || span > best.span)) best = { hnd, ys, span };
    }
    ev.push(unsteady.length ? `yaw never settled at ${unsteady.join(", ")} h (still moving after 60 s of world time): spinning, not tracking` : `yaw settled at every hour (${ORDER.map(h => `${h} h in ${samples[h].ticks} ticks`).join(", ")})`);
    ev.push(best ? `shape ${best.hnd} steady yaw at ${HOURS.join("/")} h: ${best.ys.map(y => y.toFixed(2)).join(", ")} rad, one direction, span ${best.span.toFixed(2)} rad` : `no shape's steady yaw moves one way with the hour (shapes: ${Object.keys(samples[12].yaws).join(",") || "none"})`);
    for (const hnd of Object.keys(samples[12].pitches)) ev.push(`shape ${hnd} settled pitch at ${HOURS.join("/")} h: ${HOURS.map(h => (samples[h].pitches[hnd] ?? 0).toFixed(2)).join(", ")} rad (for a single-axis tracker; the reviewer decides)`);
    const noonS = samples[12], nightS = await settle(0);
    const trivial = (v, s) => Math.abs(v - 12) < 1e-3 && s === noonS || Math.abs(v - 0) < 1e-3 && s === nightS;                   // the hour itself
    const isHourOrTemp = i => (Math.abs(noonS.st[i] - 12) < 1e-3 && Math.abs(nightS.st[i] - 0) < 1e-3) || (Math.abs(noonS.st[i] - noonS.tempK) < 0.5 && Math.abs(nightS.st[i] - nightS.tempK) < 0.5);
    const higher = i => noonS.st[i] > nightS.st[i] + 1e-3 && noonS.st[i] > 0 && !isHourOrTemp(i);
    const wSlots = (manifest?.state ?? []).filter(s => /^W\b/i.test(s.unit ?? "")).map(s => s.slot);
    const out = wSlots.find(higher) ?? noonS.st.findIndex((v, i) => higher(i));
    ev.push(out >= 0 ? `"${label(manifest, out)}"${unitOf(manifest, out) ? ` (${unitOf(manifest, out)})` : ""}: ${noonS.st[out].toFixed(2)} at noon, ${nightS.st[out].toFixed(2)} at midnight` : "no state slot (other than the hour or the temperature) is higher at noon than at midnight");
    return { pass: !unsteady.length && !!best && out >= 0, evidence: ev };
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

/**
 * 4. Wanders when the rover is far. When the rover arrives 7 m away the creature must react (its path
 * must leave the path it follows in a control episode where the rover stays far), then, once it has
 * stopped or 30 s have passed, a rock must occlude the line to the rover in 8 of 10 samples over 5 s;
 * the control episode must not be occluded by luck.
 */
export async function creature(bytes, manifest) {
  const rocks = [{ x: 8, z: 6 }, { x: -7, z: 9 }, { x: 12, z: -5 }, { x: -9, z: -8 }];
  const ev = [];
  const episode = async (approach, ticksAfter) => {
    const w = await makeWorld({ rocks, rover: { x: 60, z: 0 } });
    try {
      const o = w.add("obj", 0, 0); await w.load("obj", "candidate", bytes, manifest);
      await w.run(60);
      const moved = Math.hypot(o.position.x, o.position.z);
      if (approach) { w.rover.position.x = o.position.x + 7; w.rover.position.z = o.position.z; }
      const path = []; let still = 0, settled = null;
      const limit = ticksAfter ?? 600;                                   // up to 30 s of world time to react and stop
      for (let i = 0; i < limit; i++) {
        await w.run(1); path.push({ x: o.position.x, z: o.position.z });
        still = Math.abs(o.position.speed ?? 0) < 0.05 ? still + 1 : 0;
        if (ticksAfter === undefined && i >= 60 && still >= 10) { settled = i + 1; break; }
      }
      const samples = [];
      for (let i = 0; i < 10; i++) { await w.run(10); const c = { x: o.position.x, z: o.position.z }, r = { x: w.rover.position.x, z: w.rover.position.z }; samples.push({ c, r, hide: occluded(c, r, w.rocks) }); }
      const last = samples.at(-1), hiddenFor = samples.filter(s => s.hide).length;
      return { moved, path, settled, c: last.c, r: last.r, hide: hiddenFor >= 8 ? samples.findLast(s => s.hide).hide : null, hiddenFor, dr: Math.hypot(last.r.x - last.c.x, last.r.z - last.c.z) };
    } finally { w.close(); }
  };
  const near = await episode(true), control = await episode(false, near.path.length);
  const n = Math.min(near.path.length, control.path.length);
  let maxApart = 0; for (let i = 0; i < n; i++) maxApart = Math.max(maxApart, Math.hypot(near.path[i].x - control.path[i].x, near.path[i].z - control.path[i].z));
  const reacted = maxApart >= 0.5;
  ev.push(`moved ${near.moved.toFixed(1)} m in 3 s with the rover 60 m away`);
  ev.push(`after the rover arrived 7 m away its path left the control path (rover kept at 60 m) by at most ${maxApart.toFixed(2)} m over ${n} ticks: ${reacted ? "it reacted to the rover" : "no reaction to the rover"}`);
  ev.push(near.settled ? `it stopped after ${(near.settled * 0.05).toFixed(1)} s` : `it did not stop within ${(near.path.length * 0.05).toFixed(0)} s`);
  ev.push(near.hide ? `then occluded in ${near.hiddenFor} of 10 samples over 5 s; at the end the rock at (${near.hide.rock.x}, ${near.hide.rock.z}) sits ${near.hide.dist.toFixed(2)} m off the creature-rover line, ${(near.hide.t * 100).toFixed(0)}% of the way (rover ${near.dr.toFixed(1)} m away)`
    : `then occluded in only ${near.hiddenFor} of 10 samples over 5 s; at the end the creature (${near.c.x.toFixed(1)}, ${near.c.z.toFixed(1)}) has no rock between it and the rover (${near.dr.toFixed(1)} m away)`);
  ev.push(control.hiddenFor >= 8 ? `control (rover kept at 60 m): occluded in ${control.hiddenFor} of 10 samples there too, so hiding could be luck` : `control (rover kept at 60 m): occluded in ${control.hiddenFor} of 10 samples; no rock between them`);
  return { pass: near.moved >= 1 && reacted && !!near.hide && control.hiddenFor < 8, evidence: ev };
}

/**
 * 5. A dirt estimate (a slot that is not the tau value itself) grows by a clear ratio when every
 * optical-depth fact the module could have used is raised; the clock runs through a midnight in both
 * runs so per-hour and per-sol accumulation counts too.
 */
export async function dustGauge(bytes, manifest) {
  const { facts } = indexInfo();
  const candidates = (manifest?.fact_ids?.length ? manifest.fact_ids : Object.keys(facts)).filter(id => facts[id] && typeof facts[id].value === "number" && !facts[id].superseded_by && /optical_depth|tau/.test(id));
  const ev = [];
  if (!candidates.length) { ev.push("the manifest cites no scalar optical-depth fact and none is in the index"); return { pass: false, evidence: ev }; }
  const run = async overrides => { const w = await makeWorld({ hour: 10, factOverrides: overrides }); try { w.add("obj", 0, 0); await w.load("obj", "candidate", bytes, manifest); w.hourPerTick = 0.15; await w.run(200); return w.state("obj"); } finally { w.close(); } };   // 30 h of clock, one midnight
  const base = await run({}), high = await run(Object.fromEntries(candidates.map(id => [id, facts[id].value * 4])));
  const baseTaus = candidates.map(id => facts[id].value), highTaus = candidates.map(id => facts[id].value * 4);
  const near = (a, b) => Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(b));
  const isTauCopy = i => baseTaus.some(v => near(base[i], v)) && highTaus.some(v => near(high[i], v));   // a copy of tau in both runs, not a reading that happens to equal a tau once
  const slot = base.findIndex((v, i) => Number.isFinite(v) && v > 0 && Number.isFinite(high[i]) && high[i] / v >= 1.5 && !isTauCopy(i));
  const falling = base.findIndex((v, i) => Number.isFinite(v) && v > 0 && Number.isFinite(high[i]) && high[i] / v <= 0.67 && !isTauCopy(i));
  ev.push(`raised ${candidates.join(", ")} fourfold; 10 s of world time with the clock running 30 h through a midnight`);
  ev.push(slot >= 0 ? `"${label(manifest, slot)}": ${base[slot].toExponential(3)} with the index values, ${high[slot].toExponential(3)} raised (ratio ${(high[slot] / base[slot]).toFixed(2)})`
    : `no slot other than a copy of the tau value grew by 1.5x or more (base ${base.map((v, i) => `${i}:${v.toExponential(2)}`).filter((_, i) => base[i] !== 0 || high[i] !== 0).join(" ") || "all zero"})`);
  if (slot < 0 && falling >= 0) ev.push(`"${label(manifest, falling)}" fell from ${base[falling].toExponential(3)} to ${high[falling].toExponential(3)}: a cleanliness reading, not a dirt estimate; the reviewer decides`);
  return { pass: slot >= 0, evidence: ev };
}

export const CHECKS = { 1: weatherStation, 2: beacon, 3: solarPanel, 4: creature, 5: dustGauge };

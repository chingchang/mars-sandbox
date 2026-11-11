// Behaviour checks for the five acceptance objects, judged in the Node world: what the prompt
// asked for, observed through shapes, state slots, logs and motion. Each returns
// { pass, evidence: string[] }. These judge recorded modules; nothing here feeds the agent.
import { makeWorld } from "./world.mjs";

const COLD_K = 203.15;                                                   // -70 C, the player's threshold in prompt 1
const sig = shapes => shapes.map(s => `${s.shape}:${s.w.toFixed(2)}x${s.h.toFixed(2)}x${s.d.toFixed(2)}:${s.r.toFixed(2)},${s.g.toFixed(2)},${s.b.toFixed(2)}`).sort().join("|");
const red = s => s.r >= 0.6 && s.g <= 0.4 && s.b <= 0.4;
const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

/** 1. Logs the temperature every hour; a red flag appears below -70 C and not above. */
export async function weatherStation(bytes, manifest) {
  const w = await makeWorld({ hour: 9 }); const ev = [];
  try {
    w.add("obj", 10, 0); await w.load("obj", "candidate", bytes, manifest);
    w.hourPerTick = 1; await w.run(25, 0.05, 25);                      // t = 9 h .. 9 h next sol, one hour per tick
    const logs = w.eventsOf("obj", "actions").filter(e => e.actions.logs.length > 0).length;
    ev.push(`${logs} ticks with a log over 24 hour changes`);
    w.hourPerTick = 0;
    w.hour = 5; await w.run(4, 0.05, 25); const cold = w.shapes("obj"), coldState = w.state("obj");           // 195 K
    w.hour = 14; await w.run(4, 0.05, 25); const warm = w.shapes("obj"), warmState = w.state("obj");          // 247 K
    const flagCold = cold.some(red), flagWarm = warm.some(red);
    ev.push(`at 5 h (${w.tempK().toFixed(1)} K after the warm run; cold run was below ${COLD_K} K): red shape ${flagCold}; at 14 h: red shape ${flagWarm}`);
    const stateFlag = coldState.some((v, i) => v === 1 && warmState[i] === 0);
    if (stateFlag) ev.push("a state slot is 1 when cold and 0 when warm");
    const pass = logs >= 20 && ((flagCold && !flagWarm) || stateFlag);
    return { pass, evidence: ev };
  } finally { w.close(); }
}

/** 2. Lights up when a rover is within 20 m, not at 25 or 30 m, and stays lit at 15 m. */
export async function beacon(bytes, manifest) {
  const w = await makeWorld({ rover: { x: 30, z: 0 } }); const ev = [];
  try {
    w.add("obj", 0, 0); await w.load("obj", "candidate", bytes, manifest);
    const at = async d => { w.rover.position.x = d; await w.run(4, 0.05, 25); return { s: sig(w.shapes("obj")), st: w.state("obj") }; };
    const far = await at(30), near = await at(15), edge = await at(25), near2 = await at(15), far2 = await at(30);
    const visual = near.s !== far.s && edge.s === far.s && near2.s === near.s && far2.s === far.s;
    const binary = near.st.some((v, i) => v === 1 && far.st[i] === 0 && edge.st[i] === 0 && near2.st[i] === 1 && far2.st[i] === 0);
    ev.push(`shapes at 30 m: ${far.s || "(none)"}; at 15 m: ${near.s || "(none)"}; at 25 m same as 30 m: ${edge.s === far.s}; back to 15 m same as before: ${near2.s === near.s}`);
    if (binary) ev.push("a state slot is 1 inside 20 m and 0 at 25 and 30 m");
    return { pass: visual || binary, evidence: ev };
  } finally { w.close(); }
}

/** 3. A shape's yaw follows the sun through the day; a reported output is higher at noon than at night. */
export async function solarPanel(bytes, manifest) {
  const w = await makeWorld({ hour: 6 }); const ev = [];
  try {
    w.add("obj", 0, 0); await w.load("obj", "candidate", bytes, manifest);
    const yawAt = async h => { w.hour = h; await w.run(4, 0.05, 25); return { yaws: Object.fromEntries(w.shapes("obj").map(s => [s.handle, s.pose?.yaw ?? 0])), st: w.state("obj") }; };
    const samples = {}; for (const h of [6, 9, 12, 15, 18, 0]) samples[h] = await yawAt(h);
    const handles = Object.keys(samples[6].yaws);
    let best = null;
    for (const hnd of handles) {
      const ys = [6, 9, 12, 15, 18].map(h => samples[h].yaws[hnd]);
      const steps = ys.slice(1).map((y, i) => wrap(y - ys[i]));
      const span = Math.abs(wrap(ys[4] - ys[0]));
      const mono = steps.every(s => s > 0.02) || steps.every(s => s < -0.02);
      if (mono && (!best || span > best.span)) best = { hnd, ys, span };
    }
    ev.push(best ? `shape ${best.hnd} yaw at 6/9/12/15/18 h: ${best.ys.map(y => y.toFixed(2)).join(", ")} rad, one direction, span ${best.span.toFixed(2)} rad` : `no shape's yaw moved one way with the hour (handles ${handles.join(",") || "none"})`);
    const noon = samples[12].st, night = samples[0].st;
    const out = noon.findIndex((v, i) => v > night[i] + 1e-3 && v > 0);
    ev.push(out >= 0 ? `state slot ${out}: ${noon[out].toFixed(2)} at noon, ${night[out].toFixed(2)} at midnight` : "no state slot is higher at noon than at midnight");
    return { pass: !!best && out >= 0, evidence: ev };
  } finally { w.close(); }
}

/** 4. Wanders when the rover is far; when the rover comes close, ends up with a rock between them. */
export async function creature(bytes, manifest) {
  const rocks = [{ x: 8, z: 6 }, { x: -7, z: 9 }, { x: 12, z: -5 }, { x: -9, z: -8 }];
  const w = await makeWorld({ rocks, rover: { x: 60, z: 0 } }); const ev = [];
  try {
    const o = w.add("obj", 0, 0); await w.load("obj", "candidate", bytes, manifest);
    await w.run(60, 0.05, 20);
    const moved = Math.hypot(o.position.x, o.position.z);
    ev.push(`moved ${moved.toFixed(1)} m in 3 s with the rover 60 m away`);
    w.rover.position.x = o.position.x + 7; w.rover.position.z = o.position.z;      // the rover arrives 7 m away
    await w.run(160, 0.05, 20);
    const c = o.position, r = w.rover.position, dr = Math.hypot(r.x - c.x, r.z - c.z), toRover = Math.atan2(r.x - c.x, r.z - c.z);
    let hidden = null;
    for (const k of w.rocks) {
      const dk = Math.hypot(k.x - c.x, k.z - c.z), ang = Math.abs(wrap(Math.atan2(k.x - c.x, k.z - c.z) - toRover));
      if (dk < dr && ang < 0.6) hidden = { k, dk: dk.toFixed(1), ang: (ang * 180 / Math.PI).toFixed(0) };
    }
    ev.push(hidden ? `rock at (${hidden.k.x}, ${hidden.k.z}) is ${hidden.dk} m away, ${hidden.ang} deg off the line to the rover (${dr.toFixed(1)} m): between them` : `no rock lies between the creature (${c.x.toFixed(1)}, ${c.z.toFixed(1)}) and the rover (${dr.toFixed(1)} m away)`);
    return { pass: moved >= 1 && !!hidden, evidence: ev };
  } finally { w.close(); }
}

/** 5. A reading moves with the dust optical depth fact: larger tau, dirtier reading. */
export async function dustGauge(bytes, manifest) {
  const ev = [];
  const run = async tau => { const w = await makeWorld({ factOverrides: tau === null ? {} : { "jezero.dust.optical_depth_background_my36": tau } }); try { w.add("obj", 0, 0); await w.load("obj", "candidate", bytes, manifest); await w.run(40, 0.05, 20); return w.state("obj"); } finally { w.close(); } };
  const base = await run(null), high = await run(2.0);
  const slot = base.findIndex((v, i) => Number.isFinite(v) && Number.isFinite(high[i]) && high[i] > v + 1e-6);
  ev.push(slot >= 0 ? `state slot ${slot}: ${base[slot].toFixed(4)} with the clear-season tau fact, ${high[slot].toFixed(4)} with tau set to 2.0` : `no state slot rose when the tau fact was raised from the index value to 2.0 (base ${base.filter(v => v).map(v => v.toFixed(3)).join(",") || "all zero"})`);
  return { pass: slot >= 0, evidence: ev };
}

export const CHECKS = { 1: weatherStation, 2: beacon, 3: solarPanel, 4: creature, 5: dustGauge };
